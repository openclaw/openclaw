import { expect, it, onTestFinished, vi } from "vitest";
import { createContext, createSessions } from "../../../../ui/src/test-helpers/app-sidebar.ts";
import { installRepositoryPresentation } from "../../../../ui/src/test-helpers/repository-presentation.test-support.ts";
import { createGatewayHarness, flushSync } from "./session-pull-requests.test-support.ts";

it("does not infer reference destinations from a checkout, registered project, or adjacent link", async () => {
  const key = "agent:main:explicit-references";
  const reader = createGatewayHarness();
  reader.request.mockImplementation(async (method) =>
    method === "projects.list"
      ? {
          projects: [
            {
              id: "clawsweeper",
              displayName: "ClawSweeper",
              source: "registered",
              originUrl: "https://github.com/openclaw/clawsweeper",
            },
          ],
        }
      : { subscribed: true },
  );
  const activation = installRepositoryPresentation(
    createContext(reader.gateway, createSessions("main", [key])),
  );
  await activation.ready;
  const entry = activation.context.plugins.registrations("textReferences")[0]!;
  const lifetime = new AbortController();
  const stop = entry.value.observe?.({ sessionKey: key, signal: lifetime.signal }, vi.fn());
  onTestFinished(() => {
    lifetime.abort();
    stop?.();
  });
  await flushSync();
  reader.emit({
    sessions: {
      [key]: {
        repository: { owner: "openclaw", repo: "openclaw" },
        pullRequests: [],
        rateLimited: false,
        status: "ready",
      },
    },
  });
  await flushSync();
  const snapshot = entry.value.snapshot({ sessionKey: key });
  expect(
    snapshot.resolve({
      text: "PR #126. OpenClaw PR #1576. ClawSweeper PR #42.",
      links: ["https://github.com/acme/research/pull/126"],
    }),
  ).toEqual([]);
  expect(reader.request.mock.calls.filter(([method]) => method === "projects.list")).toHaveLength(
    0,
  );
  expect(snapshot.resolve({ text: "PR acme/explicit#42", links: [] })).toEqual([
    { start: 3, end: 19, url: "https://github.com/acme/explicit/pull/42", label: "#42" },
  ]);
});
