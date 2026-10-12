import { beforeAll, expect, it, vi } from "vitest";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  loadCompactHooksHarness,
  resolveModelMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

const { compactEmbeddedAgentSessionDirect } = await loadCompactHooksHarness();
const [context, scope] = await Promise.all([
  import("./compaction-runtime-context.js"),
  import("../agent-scope.js"),
]);
const sessionKey = "agent:main:compaction-priority";
const fixture = useCompactHooksSessionFixture(sessionKey);
let storePath: string;
beforeAll(async () => {
  storePath = await fixture.prepare();
});

it.each([
  "configured-agent",
  "projected-session",
  "explicit-list",
  "strict-empty",
  "locked",
] as const)("preserves fallback ownership during %s compaction", async (origin) => {
  const { workspaceDir, sessionId } = await fixture.prepareSession();
  const sessionTarget = { agentId: "main", sessionId, sessionKey, storePath };
  const fallbacks = ["openai/gpt-lower", "openai/gpt-peer"];
  const config = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-primary", fallbacks },
        models: {
          "openai/gpt-primary": { fallbackPriority: ["openai/gpt-peer"] },
          "openai/gpt-lower": {},
          "openai/gpt-peer": {},
        },
      },
    },
  };
  vi.mocked(scope.resolveRunModelFallbacksOverride).mockReturnValue(fallbacks);
  const projected = {
    ...(origin !== "configured-agent"
      ? {
          modelFallbacksOverride: origin === "strict-empty" ? [] : fallbacks,
          ...(origin === "projected-session" || origin === "locked"
            ? { modelFallbacksOverrideSource: "configured" as const }
            : {}),
        }
      : {}),
    modelSelectionLocked: origin === "locked",
    config,
    workspaceDir,
    provider: "openai",
    modelId: "gpt-primary",
  };
  const runtimeContext = context.buildEmbeddedCompactionRuntimeContext(projected);
  sessionCompactImpl.mockRejectedValueOnce(
    Object.assign(new Error("primary compaction overloaded"), { status: 503 }),
  );
  const result = await compactEmbeddedAgentSessionDirect({
    ...runtimeContext,
    ...sessionTarget,
    sessionTarget,
    sessionFile: sessionTarget.sessionKey,
    trigger: "overflow",
  });
  const fallbackDisabled = origin === "strict-empty" || origin === "locked";
  expect(result.ok, JSON.stringify(result)).toBe(!fallbackDisabled);
  expect(resolveModelMock.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["openai", "gpt-primary"],
    ...(fallbackDisabled
      ? []
      : [["openai", origin === "explicit-list" ? "gpt-lower" : "gpt-peer"]]),
  ]);
});
