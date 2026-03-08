const repo = (process.env.GITHUB_REPOSITORY ?? "").trim();
const token = (process.env.GITHUB_TOKEN ?? "").trim();
const prNumber = (process.argv[2] ?? process.env.PR_NUMBER ?? "").trim();

if (!repo || !token || !prNumber) {
  process.exit(0);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "openclaw-ci",
  "X-GitHub-Api-Version": "2022-11-28",
};
const validStatuses = new Set(["added", "copied", "modified", "renamed"]);

function getNextPage(linkHeader) {
  for (const part of (linkHeader ?? "").split(",")) {
    if (!part.includes('rel="next"')) {
      continue;
    }
    const start = part.indexOf("<");
    const end = part.indexOf(">", start + 1);
    if (start !== -1 && end !== -1) {
      return part.slice(start + 1, end);
    }
  }
  return "";
}

let url = new URL(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files`);
url.searchParams.set("per_page", "100");

while (url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to list PR files: ${response.status} ${response.statusText}`);
  }

  const files = await response.json();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.filename !== "string" || !validStatuses.has(file.status)) {
      continue;
    }
    console.log(file.filename);
  }

  const nextPage = getNextPage(response.headers.get("link"));
  url = nextPage ? new URL(nextPage) : null;
}
