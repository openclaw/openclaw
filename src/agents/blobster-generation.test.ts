import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { generateBlobsterForAgent } from "./blobster-generation.js";

const prepare = vi.hoisted(() => vi.fn());
const provider = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
// mock-isolation: keep model configuration independent from installed providers.
vi.mock("./utility-completion.js", () => ({ prepareUtilityCompletionForAgent: prepare }));
// mock-isolation: exercise route selection without loading provider runtimes.
vi.mock("./isolated-completion-route.js", () => ({
  resolveIsolatedCompletionProvider: provider,
  resolveIsolatedCompletionRoute: route,
}));
// mock-isolation: avoid invoking a real model in generation tests.
vi.mock("./isolated-completion.js", () => ({ runIsolatedCompletion: complete }));

const selection = { provider: "ollama", model: "qwen3:4b-instruct", agentId: "garden" };
const cfg = {
  agents: { defaults: { model: { primary: "ollama/qwen3:4b-instruct" } } },
};
const overlay = '<path d="M1 1L2 2"/>';
const design = {
  version: 1,
  id: "garden-keeper",
  name: "Garden Keeper",
  description: "A gardener with a sprout.",
  palette: { shell: "#87b891", claw: "#5b9471", glint: "#fff0b3" },
  layers: { back: "", left_prop: "", right_prop: "", shell_overlay: overlay, accessory: "" },
};
const operatorAuthority = {} as AdmittedRunOperatorAuthority;
const input = {
  cfg,
  agentId: selection.agentId,
  prompt: "A patient gardener",
  assertCurrent: () => {},
  operatorAuthority,
};
const generate = () => generateBlobsterForAgent(input);

beforeEach(() => {
  prepare.mockReset().mockResolvedValue({ config: cfg, ...selection });
  provider.mockReset().mockReturnValue({ provider: "ollama" });
  route.mockReset().mockResolvedValue({ selection: { selectedHarnessId: "openclaw" } });
  complete.mockReset().mockResolvedValue({ text: JSON.stringify(design) });
});

it("uses the agent's selected text model without tools or ClawHub", async () => {
  const result = await generate();
  expect(prepare).toHaveBeenCalledWith({ cfg, agentId: "garden", useUtilityModel: false });
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({
      ...selection,
      prompt: "A patient gardener",
      operatorAuthority,
      agentHarnessRuntimeOverride: "openclaw",
    }),
  );
  expect(result.name).toBe("Garden Keeper");
  expect(result.svg).toContain('<path d="M1 1L2 2"');
  expect(result.svg).toContain('<circle cx="45" cy="32" r="5.5"');
});

it.each([
  ["invalid JSON", "not JSON"],
  ["empty description", JSON.stringify({ ...design, description: "" })],
])("retries an invalid design (%s)", async (_name, text) => {
  complete.mockResolvedValueOnce({ text });
  await expect(generate()).resolves.toMatchObject({
    name: "Garden Keeper",
    description: design.description,
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]?.[0]?.systemPrompt).toContain(
    "previous design could not be rendered",
  );
});

it("passes model-policy denials through the typed completion authorization mapper", async () => {
  complete.mockImplementationOnce(async (request) => {
    throw request.mapOperatorAuthorizationError(
      new Error("Your operator role cannot use this model."),
    );
  });
  await expect(generate()).rejects.toMatchObject({ code: "LLM_COMPLETION_NOT_AUTHORIZED" });
  expect(complete).toHaveBeenCalledTimes(1);
});

it("does not retry provider errors", async () => {
  complete.mockRejectedValueOnce(new Error("provider offline"));
  await expect(generate()).rejects.toThrow("provider offline");
  expect(complete).toHaveBeenCalledTimes(1);
});

it("rejects a runtime that cannot guarantee a tool-free completion", async () => {
  route.mockResolvedValue({ selection: { selectedHarnessId: "agentsapi" } });
  await expect(generate()).rejects.toThrow("tool-free");
  expect(complete).not.toHaveBeenCalled();
});

describe("Blobster renderer", () => {
  const plain = {
    ...design,
    description: "A gardener",
    layers: { ...design.layers, shell_overlay: "" },
  };
  const render = async (value: unknown) => {
    complete.mockResolvedValue({ text: JSON.stringify(value) });
    return generate();
  };
  const fixtures = new URL("./blobster-fixtures/", import.meta.url);
  for (const filename of readdirSync(fixtures).filter((file) => file.endsWith(".json"))) {
    it(`renders ${filename} through the bounded SVG renderer`, async () => {
      const fixture = JSON.parse(readFileSync(new URL(filename, fixtures), "utf8"));
      // The Gateway keeps one square canvas rather than accepting model-controlled bounds.
      const { bounds: _bounds, ...fixtureDesign } = fixture;
      const { svg } = await render({
        ...fixtureDesign,
        layers: { ...plain.layers, ...fixtureDesign.layers },
      });
      expect(svg).toContain('width="256" height="256"');
      expect(svg).toContain("Copyright (c) 2026 OpenClaw Foundation");
    });
  }

  it.each([
    "<script>alert(1)</script>",
    "<foreignObject><p>Hi</p></foreignObject>",
    '<use href="#body"/>',
    '<path d="M0 0" onload="alert(1)"/>',
    '<path d="M0 0" style="fill:red"/>',
    '<path d="M0 0" fill="url(https://evil.invalid)"/>',
    '<g xmlns="http://evil.invalid"/>',
    "<!--hidden-->",
    '<?xml version="1.0"?>',
    "<!DOCTYPE svg>",
    '<circle cx="1e309"/>',
    '<circle cx="999999999"/>',
    '<path d="M1e309 0"/>',
    '<g transform="translate(1e309 0)"/>',
    '<path opacity="2"/>',
    "<g>text</g>",
    '</svg><svg><path d="M0 0"/>',
    "<g>".repeat(14) + "</g>".repeat(14),
    '<circle r="2"/>'.repeat(129),
    '<circle fill="&#117;rl(evil)"/>',
  ])("rejects active or unbounded SVG: %s", async (accessory) => {
    await expect(render({ ...plain, layers: { ...plain.layers, accessory } })).rejects.toThrow();
  });

  it("escapes metadata and retains a fixed face and square canvas", async () => {
    const { svg } = await render({ ...plain, name: '<script>&"', description: "A 🦞" });
    expect(svg).toContain("&lt;script&gt;&amp;&quot;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain('viewBox="-12 -18 144 144"');
    await expect(
      render({ ...plain, palette: { ...plain.palette, shell: "red" } }),
    ).rejects.toThrow();
    await expect(render({ ...plain, bounds: [0, 0, 1, 1] })).rejects.toThrow();
  });

  it("rejects invalid XML characters while retaining whitespace and paired Unicode", async () => {
    for (const code of [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0xd800, 0xdfff, 0xfffe, 0xffff]) {
      await expect(render({ ...plain, name: String.fromCharCode(code) })).rejects.toThrow(
        "Invalid XML text",
      );
    }
    const name = "Whitespace\t\n\r and Unicode \ud7ff\ue000\ufffd🦞";
    expect((await render({ ...plain, name })).svg).toContain(`<title>${name}</title>`);
  });

  it("keeps the Blobster silhouette when a small model draws a full-canvas backdrop and outfit", async () => {
    const { svg } = await render({
      ...plain,
      layers: {
        ...plain.layers,
        back: '<rect x="-12" y="-18" width="144" height="144" fill="#ff0000"/>',
        shell_overlay: '<rect x="16" y="8" width="88" height="96" fill="#0000ff"/>',
      },
    });
    expect(svg).not.toContain("#ff0000");
    expect(svg).toContain('<clipPath id="blobster-body-clip">');
    expect(svg).toContain(
      '<g clip-path="url(#blobster-body-clip)"><rect x="16" y="8" width="88" height="96" fill="#0000ff"></rect></g>',
    );
  });
});
