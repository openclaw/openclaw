/**
 * @param {NodeJS.ReadableStream} request
 * @param {number} maxBytes
 * @param {(limit: number) => Error} tooLargeError
 * @returns {Promise<string>}
 */
export function readBoundedRequestBody(request, maxBytes, tooLargeError) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxBytes) {
        settled = true;
        body = "";
        request.resume();
        reject(tooLargeError(maxBytes));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(body);
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
