import { vi } from "vitest";
import type { DiscordSource, GithubSource, SourceRuntime } from "./types.js";

type ReportFixtureSources = { github: GithubSource; discord?: DiscordSource };
const sources = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<ReportFixtureSources>();
});

vi.mock("./sources/github/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sources/github/index.js")>();
  return {
    ...actual,
    createGithubSource: (runtime: SourceRuntime) =>
      sources.getStore()?.github ?? actual.createGithubSource(runtime),
  };
});
vi.mock("./sources/discord/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sources/discord/index.js")>();
  return {
    ...actual,
    createDiscordSource: (runtime: SourceRuntime) =>
      sources.getStore()?.discord ?? actual.createDiscordSource(runtime),
  };
});

// Explicit native constructors let acquisition-failure cases exercise real collection, not recurse into mocks.
export const { createGithubSource: createNativeGithubSource } = await vi.importActual<
  typeof import("./sources/github/index.js")
>("./sources/github/index.js");
export const { createDiscordSource: createNativeDiscordSource } = await vi.importActual<
  typeof import("./sources/discord/index.js")
>("./sources/discord/index.js");

export function withReportSourceFixtures<T>(fixture: ReportFixtureSources, run: () => T): T {
  return sources.run(fixture, run);
}
