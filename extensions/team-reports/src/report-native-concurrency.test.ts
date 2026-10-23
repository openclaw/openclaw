import { expect, it } from "vitest";
import { bindReportFetch } from "./report-network.test-support.js";
import {
  createNativeGithubSource,
  withReportSourceFixtures,
} from "./report-source-fixtures.test-support.js";
import { createGithubSource } from "./sources/github/index.js";
import { config, json, logger } from "./sources/github/responses.fixtures.js";

it("keeps interleaved report sources and native authorization bound to their own run", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = bindReportFetch(createNativeGithubSource({ logger }), async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer first-fixture");
    entered.resolve();
    await release.promise;
    return json([{ login: "first" }]);
  });
  const second = bindReportFetch(createNativeGithubSource({ logger }), async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer second-fixture");
    return json([{ login: "second" }]);
  });
  const load = (source: typeof first, token: string) =>
    withReportSourceFixtures({ github: source }, async () => {
      await Promise.resolve();
      return createGithubSource({ logger }).loadRoster({ ...config, token });
    });
  const pending = load(first, "first-fixture");
  await entered.promise;
  let firstResult: Awaited<typeof pending> | undefined;
  try {
    expect((await load(second, "second-fixture")).people).toEqual([{ github: ["second"] }]);
  } finally {
    release.resolve();
    firstResult = await pending;
  }
  expect(firstResult?.people).toEqual([{ github: ["first"] }]);
  expect(firstResult?.status).toMatchObject({ ok: true, stats: { apiCalls: 1 } });
});
