import { open } from "node:fs/promises";
//#region node_modules/.pnpm/strtok3@10.3.4/node_modules/strtok3/lib/stream/Errors.js
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
//#endregion
//#region node_modules/.pnpm/strtok3@10.3.4/node_modules/strtok3/lib/AbstractTokenizer.js
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
	* @param length - Number of bytes to ignore
	* @return resolves the number of bytes ignored, equals length if this available, otherwise the number of bytes available
	*/
	async ignore(length) {
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
//#region node_modules/.pnpm/strtok3@10.3.4/node_modules/strtok3/lib/BufferTokenizer.js
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
//#region node_modules/.pnpm/strtok3@10.3.4/node_modules/strtok3/lib/core.js
/**
* Construct ReadStreamTokenizer from given Buffer.
* @param uint8Array - Uint8Array to tokenize
* @param options - Tokenizer options
* @returns BufferTokenizer
*/
function fromBuffer(uint8Array, options) {
	return new BufferTokenizer(uint8Array, options);
}
(class FileTokenizer extends AbstractTokenizer {
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
}).fromFile;
//#endregion
export { EndOfStreamError as n, fromBuffer as t };
