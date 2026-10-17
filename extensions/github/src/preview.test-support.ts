import { vi } from "vitest";

// List endpoints such as /pulls/{n}/commits return arrays, not objects.
export function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function previewTarget(number: number, kind: "issue" | "pull" = "issue", repo = "openclaw") {
  return { kind, number, owner: "openclaw", repo };
}

export function pngResponse() {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
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
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? "";
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
