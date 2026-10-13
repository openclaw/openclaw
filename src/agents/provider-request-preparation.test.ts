import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindModelCompletionOwner,
  bindModelLlmRuntime,
  getModelCompletionOwner,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { makeEmptyPluginMetadataOwners } from "../plugins/current-plugin-metadata.test-support.js";
import {
  attachModelProviderRequestRouteFacts,
  getModelProviderRequestRouteFacts,
  prepareModelProviderRequestRouteFacts,
  resolveProviderRequestHeaders,
} from "./provider-request-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const resolveSnapshot = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise model fact retention without opening the metadata worker.
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshotAsync: resolveSnapshot,
}));

const makeModel = () =>
  makeProviderModelFixture({
    provider: "prepared",
    id: "model",
    api: "openai-completions",
    baseUrl: "https://prepared.example/v1",
  });

const makeOwners = (family: string) => ({
  ...makeEmptyPluginMetadataOwners(),
  providerRequests: new Map([["prepared", { family }]]),
});

describe("provider request preparation", () => {
  beforeEach(() => resolveSnapshot.mockReset());

  it("prepares cold route facts asynchronously and keeps the model's runtime owner", async () => {
    const owners = makeOwners("prepared-family");
    resolveSnapshot.mockResolvedValue({ owners });
    const runtime = createLlmRuntime(createApiRegistry());
    const completionOwner = {
      run: async <T>(run: () => Promise<T>) => await run(),
      assertCurrent: vi.fn(),
    };
    const model = bindModelCompletionOwner(
      bindModelLlmRuntime(makeModel(), runtime),
      completionOwner,
    );
    const config = {};
    const prepared = await prepareModelProviderRequestRouteFacts(model, {
      config,
      workspaceDir: "/fixture/workspace",
    });

    expect(resolveSnapshot).toHaveBeenCalledExactlyOnceWith({
      config,
      workspaceDir: "/fixture/workspace",
      allowWorkspaceScopedCurrent: true,
    });
    expect(getModelProviderRequestRouteFacts(prepared)?.providerMetadataOwners).toBe(owners);
    expect(getModelProviderRequestRouteFacts(prepared)?.capabilities.knownProviderFamily).toBe(
      "prepared-family",
    );
    expect(getModelLlmRuntime(prepared)).toBe(runtime);
    expect(getModelCompletionOwner(prepared)).toBe(completionOwner);
  });

  it("reuses selected model facts while new cold models receive the next snapshot", async () => {
    const before = makeOwners("before");
    const after = makeOwners("after");
    const selected = attachModelProviderRequestRouteFacts(makeModel(), before);
    resolveSnapshot.mockResolvedValue({ owners: after });

    expect(await prepareModelProviderRequestRouteFacts(selected)).toBe(selected);
    expect(resolveSnapshot).not.toHaveBeenCalled();
    const next = await prepareModelProviderRequestRouteFacts(makeModel());
    expect(getModelProviderRequestRouteFacts(selected)?.capabilities.knownProviderFamily).toBe(
      "before",
    );
    expect(getModelProviderRequestRouteFacts(next)?.capabilities.knownProviderFamily).toBe("after");
  });

  it("derives headers from explicitly supplied facts without loading metadata", () => {
    expect(
      resolveProviderRequestHeaders({
        provider: "prepared",
        baseUrl: "https://prepared.example/v1",
        providerMetadataOwners: makeOwners("prepared-family"),
        callerHeaders: { "x-request": "fixture" },
      }),
    ).toEqual({ "x-request": "fixture" });
    expect(resolveSnapshot).not.toHaveBeenCalled();
  });
});
