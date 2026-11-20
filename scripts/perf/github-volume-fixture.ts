// Loopback GitHub runs in the harness process, outside Gateway CPU/allocation measurements.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export type GitHubVolumeRequest = {
  route: string;
  sequence: number;
  caller: string;
  bodyBytes: number;
  startedAtEpochMs: number;
  durationMs: number;
  delayMs: number;
  status: number;
  accountRevision?: number;
};

export async function startGitHubVolumeFixture(options: {
  forkCandidates: boolean;
  validators: boolean;
  onIssue: () => void;
  onUnexpected: (route: string) => void;
  onRequest: (request: GitHubVolumeRequest) => void;
}) {
  const repository = "/repos/openclaw-fixture/soak";
  const { forkCandidates, validators } = options;
  const head = "a".repeat(40);
  let firstAccountRequestAt: number | undefined;
  const requests = new Map<string, number>();
  const pull = (branch: string) => ({
    number: 17,
    title: "Synthetic dashboard pull request",
    state: "open",
    draft: false,
    html_url: "https://github.com/openclaw-fixture/soak/pull/17",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    merged_at: null,
    body: "Synthetic pull request detail. ".repeat(400),
    head: {
      sha: head,
      ref: branch,
      repo: { full_name: forkCandidates ? "fixture-fork/repo-two" : "openclaw-fixture/soak" },
    },
    base: { ref: "main", repo: { name: "soak", owner: { login: "openclaw-fixture" } } },
    additions: 125,
    deletions: 52,
    changed_files: 8,
    commits: 1,
    user: { login: "synthetic-user" },
    comments: 0,
    review_comments: 0,
  });
  async function serve(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = url.pathname + url.search;
    const sequence = (requests.get(route) ?? 0) + 1;
    requests.set(route, sequence);
    const caller = String(req.headers["x-benchmark-caller"] ?? "background");
    const startedAtEpochMs = performance.timeOrigin + performance.now();
    const delayMs = url.pathname === "/user" ? 300 + ((sequence - 1) % 3) * 300 : 0;
    let value: unknown;
    let accountRevision: number | undefined;
    if (url.pathname === "/user") {
      firstAccountRequestAt ??= Date.now();
      accountRevision = Date.now() - firstAccountRequestAt >= 60_000 ? 2 : 1;
      value = {
        id: 1516,
        login: accountRevision === 1 ? "synthetic-shared" : "synthetic-shared-updated",
        avatar_url: null,
      };
      res.setHeader("x-oauth-scopes", "repo, read:org, gist");
    } else if (url.pathname === repository) {
      value = {
        id: 1516,
        private: false,
        visibility: "public",
        fork: false,
        full_name: "openclaw-fixture/soak",
        default_branch: "main",
      };
    } else if (url.pathname === repository + "/issues/1") {
      options.onIssue();
      value = {
        title: "Synthetic dashboard issue",
        state: "open",
        number: 1,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        repository_url: "https://api.github.com" + repository,
        user: { login: "synthetic-user" },
        comments: 0,
      };
    } else if (url.pathname === repository + "/pulls") {
      value =
        forkCandidates && !url.searchParams.get("head")?.startsWith("fixture-fork:")
          ? []
          : [
              pull(
                (url.searchParams.get("head") ?? "synthetic:feature").split(":").slice(1).join(":"),
              ),
            ];
    } else if (url.pathname === repository + "/pulls/17") {
      value = pull("synthetic-feature");
    } else if (url.pathname.endsWith("/check-runs")) {
      value = {
        total_count: 100,
        check_runs: Array.from({ length: 100 }, (_, id) => ({
          id: id + 1,
          name: `synthetic-check-${id}`,
          status: "completed",
          conclusion: "success",
          output: { title: "Synthetic check", summary: "test detail ".repeat(24) },
          html_url: `https://github.com/openclaw-fixture/soak/actions/runs/${id}`,
        })),
      };
    } else if (url.pathname.endsWith("/status")) {
      value = { state: "success", statuses: [] };
    } else if (url.pathname.includes("/git/commits/")) {
      value = { sha: url.pathname.split("/").at(-1), tree: { sha: "b".repeat(40) } };
    } else if (url.pathname.includes("/compare/")) {
      value = {
        status: "ahead",
        base_commit: { sha: head, commit: { tree: { sha: "b".repeat(40) } } },
        merge_base_commit: { sha: head },
      };
    } else {
      res.writeHead(599).end();
      options.onUnexpected(route);
      return;
    }
    const body = JSON.stringify(value);
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const status = validators && req.headers["if-none-match"] === etag ? 304 : 200;
    const bodyBytes = status === 304 ? 0 : Buffer.byteLength(body);
    if (delayMs) {
      await delay(delayMs);
    }
    res
      .writeHead(status, { "content-type": "application/json", ...(validators ? { etag } : {}) })
      .end(status === 304 ? undefined : body);
    options.onRequest({
      route,
      sequence,
      caller,
      bodyBytes,
      startedAtEpochMs,
      durationMs: performance.timeOrigin + performance.now() - startedAtEpochMs,
      delayMs,
      status,
      ...(accountRevision === undefined ? {} : { accountRevision }),
    });
  }
  const server = createServer((req, res) => {
    void serve(req, res).catch(() => {
      res.destroy();
      options.onUnexpected("fixture-failure");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback GitHub address");
  }
  return {
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
