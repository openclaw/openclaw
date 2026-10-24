import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { vi } from "vitest";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import { loadControlUiGitHubPreview } from "./preview.js";

// List endpoints such as /pulls/{n}/commits return arrays, not objects.
export function githubJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers });
}

export function queuedFetch(...responses: (Response | (() => Promise<Response>))[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockImplementationOnce(async () =>
      typeof response === "function" ? response() : response,
    );
  }
  return fetcher;
}

export const avatarDataUrl = "data:image/png;base64,iVBORw==";

export function previewFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn<typeof fetch>(async (input, init) => respond(requestUrl(input), init));
}

function conditionalJson(body: unknown, etag: string) {
  return Response.json(body, { headers: { etag } });
}

export function coauthorTrailers(...authors: [string, number][]) {
  const message = authors
    .map(
      ([name, id]) =>
        `Co-authored-by: ${name} <${id}+${name.toLowerCase()}@users.noreply.github.com>`,
    )
    .join("\n");
  return [{ commit: { message } }];
}

export function previewTarget(number: number, kind: "issue" | "pull" = "issue", repo = "openclaw") {
  return { kind, number, owner: "openclaw", repo };
}

export function pngResponse(bytes = [137, 80, 78, 71]) {
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/png" },
  });
}

export function publicRepository() {
  return githubJson({ private: false, visibility: "public" });
}

export function githubRedirect(location: string) {
  return new Response(null, { status: 301, headers: { Location: location } });
}

export function requestUrl(input: RequestInfo | URL | undefined): string {
  return input instanceof Request ? input.url : String(input ?? "");
}

export function previewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    additions: 101,
    changed_files: 3,
    closed_at: "2026-07-04T09:53:52Z",
    created_at: "2026-07-04T05:03:47Z",
    deletions: 12,
    draft: false,
    merged_at: "2026-07-04T09:53:52Z",
    state: "closed",
    title: "fix(agents): derive conversation scope from trusted group facts",
    updated_at: "2026-07-04T09:53:55Z",
    base: { repo: { url: "https://api.github.com/repos/openclaw/openclaw" } },
    repository_url: "https://api.github.com/repos/openclaw/openclaw",
    user: {
      avatar_url: "https://avatars.githubusercontent.com/u/58493?v=4",
      login: "steipete",
    },
    ...overrides,
  };
}

export function managedIdentity(cacheScope: string, assertSelected: () => void = vi.fn()) {
  return {
    token: `token-${cacheScope}`,
    cacheScope,
    assertSelected,
    revalidate: vi.fn(async () => assertSelected()),
  };
}

export function conditionalPreviewFixture(
  kind: "issue" | "pull",
  number: number,
  options: {
    authors?: [string, number][];
    identity?: ControlUiGitHubPreviewIdentity;
    avatarUrl?: string | null;
    honorValidators?: boolean;
    repository?: (readCount: number) => Response;
    avatarResponse?: () => Response;
  } = {},
) {
  const state = { item: 1, commits: 1, avatar: 1, login: "steipete", unavailable: false };
  let repositoryReads = 0;
  const avatars: string[] = [];
  const itemHeaders: (string | null)[] = [];
  const commitsHeaders: (string | null)[] = [];
  const refreshed = createDeferred<void>();
  const transport = previewFetch(async (url, init) => {
    if (url.includes("avatars.githubusercontent.com")) {
      avatars.push(url);
      if (state.avatar === 2) {
        await refreshed.promise;
      }
      return options.avatarResponse?.() ?? pngResponse([state.avatar]);
    }
    if (url.endsWith("/repos/openclaw/openclaw")) {
      return options.repository?.(++repositoryReads) ?? publicRepository();
    }
    const commits = url.includes("/commits");
    const etag = `"${commits ? "commits" : "item"}-${commits ? state.commits : state.item}"`;
    const validator = new Headers(init?.headers).get("If-None-Match");
    (commits ? commitsHeaders : itemHeaders).push(validator);
    if (state.unavailable) {
      return githubJson({}, 404);
    }
    if (options.honorValidators !== false && validator === etag) {
      return new Response(null, { status: 304 });
    }
    const avatarUrl =
      options.avatarUrl === null
        ? undefined
        : (options.avatarUrl ?? "https://avatars.githubusercontent.com/u/58493");
    return conditionalJson(
      commits
        ? options.authors?.length
          ? coauthorTrailers(...options.authors)
          : [{ commit: { message: "No co-authors" } }]
        : previewPayload({
            title: `Version ${state.item}`,
            user: { login: state.login, avatar_url: avatarUrl },
          }),
      etag,
    );
  });
  const target = previewTarget(number, kind);
  const identity = options.identity ?? managedIdentity(`decoration-${number}`);
  return {
    state,
    avatars,
    itemHeaders,
    commitsHeaders,
    refreshed,
    transport,
    target,
    load: (refresh = true) => loadControlUiGitHubPreview(target, identity, transport, refresh),
  };
}
