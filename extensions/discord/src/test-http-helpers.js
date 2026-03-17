function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function urlToString(url) {
  if (typeof url === "string") {
    return url;
  }
  return "url" in url ? url.url : String(url);
}
export {
  jsonResponse,
  urlToString
};
