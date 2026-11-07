// Fixed remote I/O; collection, worker cancellation and storage remain production-owned.
export async function fetchWithSsrFGuard(params: { url: string }) {
  const url = new URL(params.url);
  let data: unknown;
  if (url.pathname === "/orgs/sample/repos") {
    data = [{ full_name: "sample/widgets", archived: false }];
  } else if (url.pathname === "/repos/sample/widgets/commits") {
    data = [
      {
        sha: "synthetic-commit",
        html_url: "https://github.com/sample/widgets/commit/synthetic",
        author: { login: "alex" },
        commit: {
          message: "Synthetic report activity",
          committer: { date: url.searchParams.get("since") },
        },
      },
    ];
  } else if (url.pathname === "/search/issues") {
    data = { total_count: 0, items: [] };
  } else if (
    /^\/repos\/sample\/widgets\/(?:issues\/comments|pulls\/comments|security-advisories)$/.test(
      url.pathname,
    )
  ) {
    data = [];
  } else {
    throw new Error(`Unexpected report fixture endpoint: ${url.pathname}`);
  }
  return { response: new Response(JSON.stringify(data)), release: async () => {} };
}
