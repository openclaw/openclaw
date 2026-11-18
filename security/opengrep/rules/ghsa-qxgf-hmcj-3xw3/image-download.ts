// Static scanner fixtures; never executed.
async function fetchImageBuffer(url) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(url);
  return response.arrayBuffer();
}

async function downloadProviderImage(payload) {
  const url = payload.images[0].url.trim();
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(url);
  return response.arrayBuffer();
}

const downloadArtifact = async (pin, name) => {
  // ok: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(
    `https://github.com/openclaw/bun/releases/download/${encodeURIComponent(pin.tag)}/${encodeURIComponent(name)}`,
    { signal: AbortSignal.timeout(300_000) },
  );
  return response.arrayBuffer();
};

async function downloadEncodedHost(host) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`https://${encodeURIComponent(host)}/image.png`);
  return response.arrayBuffer();
}

async function downloadMixedPath(tag, suffix) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`https://cdn.example.com/${encodeURIComponent(tag)}/${suffix}`);
  return response.arrayBuffer();
}

async function downloadRedirect(url) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`https://cdn.example.com/redirect?url=${encodeURIComponent(url)}`);
  return response.arrayBuffer();
}

async function downloadFollowLocation(response) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const redirected = await fetch(response.headers.get("location"));
  return redirected.arrayBuffer();
}

async function downloadSafeThenUnsafe(tag, url, name) {
  // ok: raw-image-download-fetch-without-ssrf-guard
  const safe = await fetch(
    `https://github.com/example/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const unsafe = await fetch(url);
  return [safe, unsafe];
}

async function downloadUnsafeThenSafe(tag, url, name) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const unsafe = await fetch(url);
  // ok: raw-image-download-fetch-without-ssrf-guard
  const safe = await fetch(
    `https://github.com/example/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
  return [unsafe, safe];
}

async function downloadGuarded(url) {
  // ok: raw-image-download-fetch-without-ssrf-guard
  const { response, release } = await fetchWithSsrFGuard({ url });
  try {
    return await response.arrayBuffer();
  } finally {
    await release();
  }
}

async function downloadGuardedSibling(url) {
  const { response, release } = await fetchWithSsrFGuard({ url });
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const unsafe = await fetch(url);
  await release();
  return unsafe.arrayBuffer();
}

async function downloadLiteral() {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch("https://cdn.example.com/releases/runtime.zip");
  return response.arrayBuffer();
}

async function downloadScheme(scheme, name) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`${scheme}://cdn.example.com/${encodeURIComponent(name)}`);
  return response.arrayBuffer();
}

async function downloadSubdomain(host, name) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`https://${host}.example.com/${encodeURIComponent(name)}`);
  return response.arrayBuffer();
}

async function downloadUserinfo(user, name) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`https://${user}@cdn.example.com/${encodeURIComponent(name)}`);
  return response.arrayBuffer();
}

async function downloadAlias(url) {
  const alias = url;
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(alias);
  return response.arrayBuffer();
}

async function downloadPathRedirect(url) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const response = await fetch(`https://redirector.example/redirect/${encodeURIComponent(url)}`);
  return response.arrayBuffer();
}

async function downloadEndpointVariants(owner, repo, tag, name, url) {
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const lookalike = await fetch(
    `https://github.com.example.net/example/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const userinfo = await fetch(
    `https://github.com@example.net/example/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const dynamicOwner = await fetch(
    `https://github.com/${owner}/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const dynamicRepo = await fetch(
    `https://github.com/example/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const rawTag = await fetch(
    `https://github.com/example/project/releases/download/${tag}/${encodeURIComponent(name)}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const rawAsset = await fetch(
    `https://github.com/example/project/releases/download/${encodeURIComponent(tag)}/${name}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const query = await fetch(
    `https://github.com/example/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}?redirect=${url}`,
  );
  // ruleid: raw-image-download-fetch-without-ssrf-guard
  const concat = await fetch(
    `https://github.com/example/project/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` +
      url,
  );
  return [lookalike, userinfo, dynamicOwner, dynamicRepo, rawTag, rawAsset, query, concat];
}
