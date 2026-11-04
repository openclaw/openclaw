export type RouteNetworkObservation = {
  requestId: string;
  url: string;
  timestampSeconds?: number;
  finishedTimestampSeconds?: number;
  wireBytes?: number;
  failed?: string;
};

export function qualifyRouteNetworkClock(
  requests: RouteNetworkObservation[],
  navigationStart: number,
  resources: { url: string; startTime: number; responseEnd: number }[],
) {
  const available = new Map<string, typeof resources>();
  for (const resource of resources.toSorted((a, b) => a.startTime - b.startTime)) {
    const sameUrl = available.get(resource.url) ?? [];
    sameUrl.push(resource);
    available.set(resource.url, sameUrl);
  }
  const matches = [];
  const unmatchedRequestIds = [];
  for (const request of requests.toSorted(
    (a, b) => (a.timestampSeconds ?? 0) - (b.timestampSeconds ?? 0),
  )) {
    if (
      !new URL(request.url).pathname.startsWith("/assets/") ||
      request.timestampSeconds === undefined ||
      request.finishedTimestampSeconds === undefined ||
      request.failed
    ) {
      continue;
    }
    const resource = available.get(request.url)?.shift();
    if (!resource) {
      unmatchedRequestIds.push(request.requestId);
      continue;
    }
    const requestStartMs = (request.timestampSeconds - navigationStart) * 1_000;
    const requestEndMs = (request.finishedTimestampSeconds - navigationStart) * 1_000;
    matches.push({
      requestId: request.requestId,
      url: request.url,
      requestStartMs,
      requestEndMs,
      resourceStartMs: resource.startTime,
      resourceEndMs: resource.responseEnd,
      startResidualMs: requestStartMs - resource.startTime,
      endResidualMs: requestEndMs - resource.responseEnd,
    });
  }
  const maxResidualMs = matches.length
    ? Math.max(
        ...matches.flatMap((match) => [
          Math.abs(match.startResidualMs),
          Math.abs(match.endResidualMs),
        ]),
      )
    : null;
  return {
    passed:
      Number.isFinite(navigationStart) &&
      navigationStart > 0 &&
      matches.length > 0 &&
      maxResidualMs !== null &&
      maxResidualMs <= 5,
    navigationStart,
    toleranceMs: 5,
    matchedCount: matches.length,
    maxResidualMs,
    matches,
    unmatchedRequestIds,
  };
}

export function routeNetworkPhase(
  requests: RouteNetworkObservation[],
  navigationStart: number,
  startMs: number,
  endMs: number,
) {
  if (!Number.isFinite(navigationStart) || navigationStart <= 0) {
    throw new Error("Apps phase accounting requires the actual Performance.NavigationStart metric");
  }
  const start = navigationStart + startMs / 1_000;
  const end = navigationStart + endMs / 1_000;
  const select = (kind: "js" | "css") => {
    const resources = requests.filter((request) =>
      kind === "js"
        ? /\.m?js$/u.test(new URL(request.url).pathname)
        : new URL(request.url).pathname.endsWith(".css"),
    );
    if (resources.some((request) => !Number.isFinite(request.timestampSeconds))) {
      throw new Error("Apps phase accounting requires raw Network.requestWillBeSent timestamps");
    }
    const started = resources.filter(
      (request) => request.timestampSeconds! > start && request.timestampSeconds! <= end,
    );
    const completed = resources.filter(
      (request) =>
        request.finishedTimestampSeconds !== undefined &&
        request.finishedTimestampSeconds > start &&
        request.finishedTimestampSeconds <= end,
    );
    const pending = resources.filter(
      (request) =>
        !request.failed &&
        request.timestampSeconds! <= end &&
        (request.finishedTimestampSeconds === undefined || request.finishedTimestampSeconds > end),
    );
    return {
      started,
      completed,
      pendingAtEnd: pending,
      completedEncodedBytes: completed.reduce((sum, request) => sum + (request.wireBytes ?? 0), 0),
    };
  };
  return {
    startMs,
    endMs,
    navigationStart,
    rawClock:
      "CDP MonotonicTime seconds; phase boundaries use actual Performance.NavigationStart + same-document performance.now()/1000",
    js: select("js"),
    css: select("css"),
  };
}
