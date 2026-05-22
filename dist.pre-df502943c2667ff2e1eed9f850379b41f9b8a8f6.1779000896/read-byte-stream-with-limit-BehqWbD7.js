//#region src/media/read-byte-stream-with-limit.ts
function normalizeByteChunk(chunk) {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (typeof chunk === "string") return Buffer.from(chunk);
	if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
	if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	throw new TypeError(`Unsupported byte stream chunk: ${typeof chunk}`);
}
function destroyReadableOnOverflow(stream, err) {
	const readable = stream;
	if (typeof readable.destroy === "function") {
		try {
			readable.destroy(err);
		} catch {}
		return;
	}
	if (typeof readable.cancel === "function") try {
		readable.cancel(err);
	} catch {}
}
async function readByteStreamWithLimit(stream, opts) {
	const { maxBytes } = opts;
	if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError(`maxBytes must be a non-negative finite number: ${maxBytes}`);
	const onOverflow = opts.onOverflow ?? ((params) => /* @__PURE__ */ new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
	const chunks = [];
	let total = 0;
	for await (const chunk of stream) {
		const buffer = normalizeByteChunk(chunk);
		if (buffer.byteLength === 0) continue;
		const nextTotal = total + buffer.byteLength;
		if (nextTotal > maxBytes) {
			const err = onOverflow({
				size: nextTotal,
				maxBytes
			});
			destroyReadableOnOverflow(stream, err);
			throw err;
		}
		chunks.push(buffer);
		total = nextTotal;
	}
	return Buffer.concat(chunks, total);
}
//#endregion
export { readByteStreamWithLimit as t };
