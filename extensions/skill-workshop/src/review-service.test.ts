import type { OpenClawPluginApi as Api } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WorkshopChange } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { expect, it, vi } from "vitest";
import { registerSkillWorkshopReview } from "./review-service.js";
import { setWorkshopRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  diet: vi.fn(async () => undefined),
}));
// mock-isolation: maintenance internals stay out; the test proves its scheduling and stop.
vi.mock("./tool-policy-diagnostic.js", () => ({
  isSkillWorkshopDeniedForAgent: async () => false,
}));
// mock-isolation: the archive is held open to prove a stopping service waits for it.
vi.mock("./unused-archive.js", () => ({ archiveUnusedWorkshopSkills: mocks.archive }));
// mock-isolation: the diet's model call must not run after the stop signal.
vi.mock("./skill-diet.js", () => ({ runWorkshopSkillDiet: mocks.diet }));

type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

it("runs daily maintenance once per agent as a service job that a stop waits for", async () => {
  const archive = Promise.withResolvers<WorkshopChange[]>();
  mocks.archive.mockReturnValue(archive.promise);
  const runtime = createPluginRuntimeMock();
  vi.spyOn(runtime.config, "current").mockReturnValue({
    plugins: { entries: { "skill-workshop": { config: { autonomous: { mode: "auto" } } } } },
  });
  setWorkshopRuntime(runtime);
  const on = vi.fn<Api["on"]>();
  const registerService = vi.fn<Api["registerService"]>();
  const api = createTestPluginApi({ id: "skill-workshop", runtime, on, registerService });
  registerSkillWorkshopReview(api);
  const service = registerService.mock.calls.find(([entry]) => entry.apiVersion === 2)?.[0];
  if (service?.apiVersion !== 2) {
    throw new Error("Expected service API version 2");
  }
  const agentEnd = on.mock.calls.find(([name]) => name === "agent_end")?.[1] as Hook | undefined;
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler("fake-timers"));
  const ctx = { config: {}, stateDir: "/tmp/skill-workshop-test", logger: api.logger, scheduler };
  await service?.start(ctx);

  agentEnd?.({}, { agentId: "main" });
  agentEnd?.({}, { agentId: "main" });
  await vi.waitFor(() => expect(mocks.archive).toHaveBeenCalledTimes(1));

  // Graceful restart: stopping the service waits for the running archive, then skips the diet.
  await service?.stop?.(ctx);
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  expect(stopped).toBe(false);
  archive.resolve([]);
  await stopping;
  expect(mocks.archive).toHaveBeenCalledTimes(1);
  expect(mocks.diet).not.toHaveBeenCalled();
});
