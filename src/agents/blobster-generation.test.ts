import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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

const cfg: OpenClawConfig = {
  agents: { defaults: { model: { primary: "ollama/qwen3:4b-instruct" } } },
};
const design = {
  version: 1,
  id: "garden-keeper",
  name: "Garden Keeper",
  description: "A gardener with a sprout.",
  palette: { shell: "#87b891", claw: "#5b9471", glint: "#fff0b3" },
  layers: {
    back: "",
    left_prop: "",
    right_prop: "",
    shell_overlay: '<path d="M35 49 L85 49 L80 85 L40 85 Z" fill="#f1e4c4"/>',
    accessory: "",
  },
};
const operatorAuthority = {} as AdmittedRunOperatorAuthority;
const input = {
  cfg,
  agentId: "garden",
  prompt: "A patient gardener",
  assertCurrent: vi.fn(),
  operatorAuthority,
};

beforeEach(() => {
  prepare.mockReset().mockResolvedValue({
    config: cfg,
    agentId: "garden",
    provider: "ollama",
    model: "qwen3:4b-instruct",
    thinkLevel: "off",
    outputTextPolicy: "strict-visible",
  });
  provider.mockReset().mockReturnValue({ provider: "ollama" });
  route.mockReset().mockResolvedValue({ selection: { selectedHarnessId: "openclaw" } });
  complete.mockReset().mockResolvedValue({ text: JSON.stringify(design) });
  input.assertCurrent.mockReset();
});

it("uses the agent's selected text model without tools or ClawHub", async () => {
  const result = await generateBlobsterForAgent(input);
  expect(prepare).toHaveBeenCalledWith({
    cfg,
    agentId: "garden",
    useUtilityModel: false,
  });
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "ollama",
      model: "qwen3:4b-instruct",
      agentId: "garden",
      prompt: "A patient gardener",
      operatorAuthority,
      agentHarnessRuntimeOverride: "openclaw",
    }),
  );
  expect(result.name).toBe("Garden Keeper");
  expect(result.svg).toContain('<path d="M35 49 L85 49 L80 85 L40 85 Z"');
  expect(result.svg).toContain('<circle cx="45" cy="32" r="5.5"');
});

it("rejects active model markup even when the model returns valid JSON", async () => {
  complete.mockResolvedValue({
    text: JSON.stringify({
      ...design,
      layers: { ...design.layers, accessory: '<image href="https://evil.invalid/a.png"/>' },
    }),
  });
  await expect(generateBlobsterForAgent(input)).rejects.toThrow("Unsupported SVG");
  expect(complete).toHaveBeenCalledTimes(2);
});

it("retries once when the model returns an invalid design", async () => {
  complete.mockResolvedValueOnce({ text: "not JSON" }).mockResolvedValueOnce({
    text: JSON.stringify(design),
  });
  const result = await generateBlobsterForAgent(input);
  expect(result.name).toBe("Garden Keeper");
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]?.[0]?.systemPrompt).toContain(
    "previous design could not be rendered",
  );
});

it("retries a design with an empty description before returning a preview", async () => {
  complete.mockResolvedValueOnce({ text: JSON.stringify({ ...design, description: "" }) });
  const result = await generateBlobsterForAgent(input);
  expect(result.description).toBe(design.description);
  expect(complete).toHaveBeenCalledTimes(2);
});

it("passes model-policy denials through the typed completion authorization mapper", async () => {
  complete.mockImplementationOnce(async (request) => {
    throw request.mapOperatorAuthorizationError(
      new Error("Your operator role cannot use this model."),
    );
  });
  await expect(generateBlobsterForAgent(input)).rejects.toMatchObject({
    code: "LLM_COMPLETION_NOT_AUTHORIZED",
  });
  expect(complete).toHaveBeenCalledTimes(1);
});

it("does not retry provider errors", async () => {
  complete.mockRejectedValueOnce(new Error("provider offline"));
  await expect(generateBlobsterForAgent(input)).rejects.toThrow("provider offline");
  expect(complete).toHaveBeenCalledTimes(1);
});

it("rejects a runtime that cannot guarantee a tool-free completion", async () => {
  route.mockResolvedValue({ selection: { selectedHarnessId: "agentsapi" } });
  await expect(generateBlobsterForAgent(input)).rejects.toThrow("tool-free");
  expect(complete).not.toHaveBeenCalled();
});
