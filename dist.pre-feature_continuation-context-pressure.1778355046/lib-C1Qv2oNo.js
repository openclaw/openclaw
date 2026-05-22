import { open, stat } from "node:fs/promises";
//#region node_modules/strtok3/lib/stream/Errors.js
const defaultMessages = "End-Of-Stream";
/**
* Thrown on read operation of the end of file or stream has been reached
*/
var EndOfStreamError = class extends Error {
	constructor() {
		super(defaultMessages);
		this.name = "EndOfStreamError";
	}
};
var AbortError = class extends Error {
	constructor(message = "The operation was aborted") {
		super(message);
		this.name = "AbortError";
	}
};
//#endregion
//#region node_modules/strtok3/lib/stream/Deferred.js
var Deferred = class {
	constructor() {
		this.resolve = () => null;
		this.reject = () => null;
		this.promise = new Promise((resolve, reject) => {
			this.reject = reject;
			this.resolve = resolve;
		});
	}
};
//#endregion
//#region node_modules/strtok3/lib/stream/AbstractStreamReader.js
var AbstractStreamReader = class {
	constructor() {
		this.endOfStream = false;
		this.interrupted = false;
		/**
		* Store peeked data
		* @type {Array}
		*/
		this.peekQueue = [];
	}
	async peek(uint8Array, mayBeLess = false) {
		const bytesRead = await this.read(uint8Array, mayBeLess);
		this.peekQueue.push(uint8Array.subarray(0, bytesRead));
		return bytesRead;
	}
	async read(buffer, mayBeLess = false) {
		if (buffer.length === 0) return 0;
		let bytesRead = this.readFromPeekBuffer(buffer);
		if (!this.endOfStream) bytesRead += await this.readRemainderFromStream(buffer.subarray(bytesRead), mayBeLess);
		if (bytesRead === 0 && !mayBeLess) throw new EndOfStreamError();
		return bytesRead;
	}
	/**
	* Read chunk from stream
	* @param buffer - Target Uint8Array (or Buffer) to store data read from stream in
	* @returns Number of bytes read
	*/
	readFromPeekBuffer(buffer) {
		let remaining = buffer.length;
		let bytesRead = 0;
		while (this.peekQueue.length > 0 && remaining > 0) {
			const peekData = this.peekQueue.pop();
			if (!peekData) throw new Error("peekData should be defined");
			const lenCopy = Math.min(peekData.length, remaining);
			buffer.set(peekData.subarray(0, lenCopy), bytesRead);
			bytesRead += lenCopy;
			remaining -= lenCopy;
			if (lenCopy < peekData.length) this.peekQueue.push(peekData.subarray(lenCopy));
		}
		return bytesRead;
	}
	async readRemainderFromStream(buffer, mayBeLess) {
		let bytesRead = 0;
		while (bytesRead < buffer.length && !this.endOfStream) {
			if (this.interrupted) throw new AbortError();
			const chunkLen = await this.readFromStream(buffer.subarray(bytesRead), mayBeLess);
			if (chunkLen === 0) break;
			bytesRead += chunkLen;
		}
		if (!mayBeLess && bytesRead < buffer.length) throw new EndOfStreamError();
		return bytesRead;
	}
};
//#endregion
//#region node_modules/strtok3/lib/stream/StreamReader.js
/**
* Node.js Readable Stream Reader
* Ref: https://nodejs.org/api/stream.html#readable-streams
*/
var StreamReader = class extends AbstractStreamReader {
	constructor(s) {
		super();
		this.s = s;
		/**
		* Deferred used for postponed read request (as not data is yet available to read)
		*/
		this.deferred = null;
		if (!s.read || !s.once) throw new Error("Expected an instance of stream.Readable");
		this.s.once("end", () => {
			this.endOfStream = true;
			if (this.deferred) this.deferred.resolve(0);
		});
		this.s.once("error", (err) => this.reject(err));
		this.s.once("close", () => this.abort());
	}
	/**
	* Read chunk from stream
	* @param buffer Target Uint8Array (or Buffer) to store data read from stream in
	* @param mayBeLess - If true, may fill the buffer partially
	* @returns Number of bytes read
	*/
	async readFromStream(buffer, mayBeLess) {
		if (buffer.length === 0) return 0;
		const readBuffer = this.s.read(buffer.length);
		if (readBuffer) {
			buffer.set(readBuffer);
			return readBuffer.length;
		}
		const request = {
			buffer,
			mayBeLess,
			deferred: new Deferred()
		};
		this.deferred = request.deferred;
		this.s.once("readable", () => {
			this.readDeferred(request);
		});
		return request.deferred.promise;
	}
	/**
	* Process deferred read request
	* @param request Deferred read request
	*/
	readDeferred(request) {
		const readBuffer = this.s.read(request.buffer.length);
		if (readBuffer) {
			request.buffer.set(readBuffer);
			request.deferred.resolve(readBuffer.length);
			this.deferred = null;
		} else this.s.once("readable", () => {
			this.readDeferred(request);
		});
	}
	reject(err) {
		this.interrupted = true;
		if (this.deferred) {
			this.deferred.reject(err);
			this.deferred = null;
		}
	}
	async abort() {
		this.reject(new AbortError());
	}
	async close() {
		return this.abort();
	}
};
//#endregion
//#region node_modules/strtok3/lib/AbstractTokenizer.js
/**
* Core tokenizer
*/
var AbstractTokenizer = class {
	/**
	* Constructor
	* @param options Tokenizer options
	* @protected
	*/
	constructor(options) {
		this.numBuffer = new Uint8Array(8);
		/**
		* Tokenizer-stream position
		*/
		this.position = 0;
		this.onClose = options?.onClose;
		if (options?.abortSignal) options.abortSignal.addEventListener("abort", () => {
			this.abort();
		});
	}
	/**
	* Read a token from the tokenizer-stream
	* @param token - The token to read
	* @param position - If provided, the desired position in the tokenizer-stream
	* @returns Promise with token data
	*/
	async readToken(token, position = this.position) {
		const uint8Array = new Uint8Array(token.len);
		if (await this.readBuffer(uint8Array, { position }) < token.len) throw new EndOfStreamError();
		return token.get(uint8Array, 0);
	}
	/**
	* Peek a token from the tokenizer-stream.
	* @param token - Token to peek from the tokenizer-stream.
	* @param position - Offset where to begin reading within the file. If position is null, data will be read from the current file position.
	* @returns Promise with token data
	*/
	async peekToken(token, position = this.position) {
		const uint8Array = new Uint8Array(token.len);
		if (await this.peekBuffer(uint8Array, { position }) < token.len) throw new EndOfStreamError();
		return token.get(uint8Array, 0);
	}
	/**
	* Read a numeric token from the stream
	* @param token - Numeric token
	* @returns Promise with number
	*/
	async readNumber(token) {
		if (await this.readBuffer(this.numBuffer, { length: token.len }) < token.len) throw new EndOfStreamError();
		return token.get(this.numBuffer, 0);
	}
	/**
	* Read a numeric token from the stream
	* @param token - Numeric token
	* @returns Promise with number
	*/
	async peekNumber(token) {
		if (await this.peekBuffer(this.numBuffer, { length: token.len }) < token.len) throw new EndOfStreamError();
		return token.get(this.numBuffer, 0);
	}
	/**
	* Ignore number of bytes, advances the pointer in under tokenizer-stream.
	* @param length - Number of bytes to ignore.  Must be ≥ 0.
	* @return resolves the number of bytes ignored, equals length if this available, otherwise the number of bytes available
	*/
	async ignore(length) {
		if (length < 0) throw new RangeError("ignore length must be ≥ 0 bytes");
		if (this.fileInfo.size !== void 0) {
			const bytesLeft = this.fileInfo.size - this.position;
			if (length > bytesLeft) {
				this.position += bytesLeft;
				return bytesLeft;
			}
		}
		this.position += length;
		return length;
	}
	async close() {
		await this.abort();
		await this.onClose?.();
	}
	normalizeOptions(uint8Array, options) {
		if (!this.supportsRandomAccess() && options && options.position !== void 0 && options.position < this.position) throw new Error("`options.position` must be equal or greater than `tokenizer.position`");
		return {
			mayBeLess: false,
			offset: 0,
			length: uint8Array.length,
			position: this.position,
			...options
		};
	}
	abort() {
		return Promise.resolve();
	}
};
//#endregion
//#region node_modules/strtok3/lib/ReadStreamTokenizer.js
const maxBufferSize = 256e3;
var ReadStreamTokenizer = class extends AbstractTokenizer {
	/**
	* Constructor
	* @param streamReader stream-reader to read from
	* @param options Tokenizer options
	*/
	constructor(streamReader, options) {
		super(options);
		this.streamReader = streamReader;
		this.fileInfo = options?.fileInfo ?? {};
	}
	/**
	* Read buffer from tokenizer
	* @param uint8Array - Target Uint8Array to fill with data read from the tokenizer-stream
	* @param options - Read behaviour options
	* @returns Promise with number of bytes read
	*/
	async readBuffer(uint8Array, options) {
		const normOptions = this.normalizeOptions(uint8Array, options);
		const skipBytes = normOptions.position - this.position;
		if (skipBytes > 0) {
			await this.ignore(skipBytes);
			return this.readBuffer(uint8Array, options);
		}
		if (skipBytes < 0) throw new Error("`options.position` must be equal or greater than `tokenizer.position`");
		if (normOptions.length === 0) return 0;
		const bytesRead = await this.streamReader.read(uint8Array.subarray(0, normOptions.length), normOptions.mayBeLess);
		this.position += bytesRead;
		if ((!options || !options.mayBeLess) && bytesRead < normOptions.length) throw new EndOfStreamError();
		return bytesRead;
	}
	/**
	* Peek (read ahead) buffer from tokenizer
	* @param uint8Array - Uint8Array (or Buffer) to write data to
	* @param options - Read behaviour options
	* @returns Promise with number of bytes peeked
	*/
	async peekBuffer(uint8Array, options) {
		const normOptions = this.normalizeOptions(uint8Array, options);
		let bytesRead = 0;
		if (normOptions.position) {
			const skipBytes = normOptions.position - this.position;
			if (skipBytes > 0) {
				const skipBuffer = new Uint8Array(normOptions.length + skipBytes);
				bytesRead = await this.peekBuffer(skipBuffer, { mayBeLess: normOptions.mayBeLess });
				uint8Array.set(skipBuffer.subarray(skipBytes));
				return bytesRead - skipBytes;
			}
			if (skipBytes < 0) throw new Error("Cannot peek from a negative offset in a stream");
		}
		if (normOptions.length > 0) {
			try {
				bytesRead = await this.streamReader.peek(uint8Array.subarray(0, normOptions.length), normOptions.mayBeLess);
			} catch (err) {
				if (options?.mayBeLess && err instanceof EndOfStreamError) return 0;
				throw err;
			}
			if (!normOptions.mayBeLess && bytesRead < normOptions.length) throw new EndOfStreamError();
		}
		return bytesRead;
	}
	/**
	* @param length Number of bytes to ignore. Must be ≥ 0.
	*/
	async ignore(length) {
		if (length < 0) throw new RangeError("ignore length must be ≥ 0 bytes");
		const bufSize = Math.min(maxBufferSize, length);
		const buf = new Uint8Array(bufSize);
		let totBytesRead = 0;
		while (totBytesRead < length) {
			const remaining = length - totBytesRead;
			const bytesRead = await this.readBuffer(buf, { length: Math.min(bufSize, remaining) });
			if (bytesRead < 0) return bytesRead;
			totBytesRead += bytesRead;
		}
		return totBytesRead;
	}
	abort() {
		return this.streamReader.abort();
	}
	async close() {
		return this.streamReader.close();
	}
	supportsRandomAccess() {
		return false;
	}
};
//#endregion
//#region node_modules/strtok3/lib/BufferTokenizer.js
var BufferTokenizer = class extends AbstractTokenizer {
	/**
	* Construct BufferTokenizer
	* @param uint8Array - Uint8Array to tokenize
	* @param options Tokenizer options
	*/
	constructor(uint8Array, options) {
		super(options);
		this.uint8Array = uint8Array;
		this.fileInfo = {
			...options?.fileInfo ?? {},
			size: uint8Array.length
		};
	}
	/**
	* Read buffer from tokenizer
	* @param uint8Array - Uint8Array to tokenize
	* @param options - Read behaviour options
	* @returns {Promise<number>}
	*/
	async readBuffer(uint8Array, options) {
		if (options?.position) this.position = options.position;
		const bytesRead = await this.peekBuffer(uint8Array, options);
		this.position += bytesRead;
		return bytesRead;
	}
	/**
	* Peek (read ahead) buffer from tokenizer
	* @param uint8Array
	* @param options - Read behaviour options
	* @returns {Promise<number>}
	*/
	async peekBuffer(uint8Array, options) {
		const normOptions = this.normalizeOptions(uint8Array, options);
		const bytes2read = Math.min(this.uint8Array.length - normOptions.position, normOptions.length);
		if (!normOptions.mayBeLess && bytes2read < normOptions.length) throw new EndOfStreamError();
		uint8Array.set(this.uint8Array.subarray(normOptions.position, normOptions.position + bytes2read));
		return bytes2read;
	}
	close() {
		return super.close();
	}
	supportsRandomAccess() {
		return true;
	}
	setPosition(position) {
		this.position = position;
	}
};
//#endregion
//#region node_modules/strtok3/lib/core.js
/**
* Construct ReadStreamTokenizer from given Stream.
* Will set fileSize, if provided given Stream has set the .path property/
* @param stream - Read from Node.js Stream.Readable
* @param options - Tokenizer options
* @returns ReadStreamTokenizer
*/
function fromStream$1(stream, options) {
	const streamReader = new StreamReader(stream);
	const _options = options ?? {};
	const chainedClose = _options.onClose;
	_options.onClose = async () => {
		await streamReader.close();
		if (chainedClose) return chainedClose();
	};
	return new ReadStreamTokenizer(streamReader, _options);
}
/**
* Construct ReadStreamTokenizer from given Buffer.
* @param uint8Array - Uint8Array to tokenize
* @param options - Tokenizer options
* @returns BufferTokenizer
*/
function fromBuffer(uint8Array, options) {
	return new BufferTokenizer(uint8Array, options);
}
//#endregion
//#region node_modules/strtok3/lib/FileTokenizer.js
var FileTokenizer = class FileTokenizer extends AbstractTokenizer {
	/**
	* Create tokenizer from provided file path
	* @param sourceFilePath File path
	*/
	static async fromFile(sourceFilePath) {
		const fileHandle = await open(sourceFilePath, "r");
		return new FileTokenizer(fileHandle, { fileInfo: {
			path: sourceFilePath,
			size: (await fileHandle.stat()).size
		} });
	}
	constructor(fileHandle, options) {
		super(options);
		this.fileHandle = fileHandle;
		this.fileInfo = options.fileInfo;
	}
	/**
	* Read buffer from file
	* @param uint8Array - Uint8Array to write result to
	* @param options - Read behaviour options
	* @returns Promise number of bytes read
	*/
	async readBuffer(uint8Array, options) {
		const normOptions = this.normalizeOptions(uint8Array, options);
		this.position = normOptions.position;
		if (normOptions.length === 0) return 0;
		const res = await this.fileHandle.read(uint8Array, 0, normOptions.length, normOptions.position);
		this.position += res.bytesRead;
		if (res.bytesRead < normOptions.length && (!options || !options.mayBeLess)) throw new EndOfStreamError();
		return res.bytesRead;
	}
	/**
	* Peek buffer from file
	* @param uint8Array - Uint8Array (or Buffer) to write data to
	* @param options - Read behaviour options
	* @returns Promise number of bytes read
	*/
	async peekBuffer(uint8Array, options) {
		const normOptions = this.normalizeOptions(uint8Array, options);
		const res = await this.fileHandle.read(uint8Array, 0, normOptions.length, normOptions.position);
		if (!normOptions.mayBeLess && res.bytesRead < normOptions.length) throw new EndOfStreamError();
		return res.bytesRead;
	}
	async close() {
		await this.fileHandle.close();
		return super.close();
	}
	setPosition(position) {
		this.position = position;
	}
	supportsRandomAccess() {
		return true;
	}
};
//#endregion
//#region node_modules/strtok3/lib/index.js
/**
* Construct ReadStreamTokenizer from given Stream.
* Will set fileSize, if provided given Stream has set the .path property.
* @param stream - Node.js Stream.Readable
* @param options - Pass additional file information to the tokenizer
* @returns Tokenizer
*/
async function fromStream(stream, options) {
	const rst = fromStream$1(stream, options);
	if (stream.path) {
		const stat$1 = await stat(stream.path);
		rst.fileInfo.path = stream.path;
		rst.fileInfo.size = stat$1.size;
	}
	return rst;
}
const fromFile = FileTokenizer.fromFile;
//#endregion
export { EndOfStreamError as i, fromStream as n, fromBuffer as r, fromFile as t };
