import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { D as Uint8ArrayType, E as UINT8, S as UINT32_BE, _ as StringType, s as makeUnexpectedFileContentError, t as BasicParser, v as UINT16_BE } from "./BasicParser-CrFlghez.js";
import { n as EndOfStreamError, t as fromBuffer } from "./lib-BPhRo--R.js";
import { i as FourCcToken } from "./APEv2Parser-CGbu4tbE.js";
import { t as ID3v2Parser } from "./ID3v2Parser-tWfk9L8J.js";
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/aiff/AiffToken.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
const compressionTypes = {
	NONE: "not compressed	PCM	Apple Computer",
	sowt: "PCM (byte swapped)",
	fl32: "32-bit floating point IEEE 32-bit float",
	fl64: "64-bit floating point IEEE 64-bit float	Apple Computer",
	alaw: "ALaw 2:1	8-bit ITU-T G.711 A-law",
	ulaw: "µLaw 2:1	8-bit ITU-T G.711 µ-law	Apple Computer",
	ULAW: "CCITT G.711 u-law 8-bit ITU-T G.711 µ-law",
	ALAW: "CCITT G.711 A-law 8-bit ITU-T G.711 A-law",
	FL32: "Float 32	IEEE 32-bit float "
};
var AiffContentError = class extends makeUnexpectedFileContentError("AIFF") {};
var Common = class {
	constructor(header, isAifc) {
		this.isAifc = isAifc;
		const minimumChunkSize = isAifc ? 22 : 18;
		if (header.chunkSize < minimumChunkSize) throw new AiffContentError(`COMMON CHUNK size should always be at least ${minimumChunkSize}`);
		this.len = header.chunkSize;
	}
	get(buf, off) {
		const shift = UINT16_BE.get(buf, off + 8) - 16398;
		const baseSampleRate = UINT16_BE.get(buf, off + 8 + 2);
		const res = {
			numChannels: UINT16_BE.get(buf, off),
			numSampleFrames: UINT32_BE.get(buf, off + 2),
			sampleSize: UINT16_BE.get(buf, off + 6),
			sampleRate: shift < 0 ? baseSampleRate >> Math.abs(shift) : baseSampleRate << shift
		};
		if (this.isAifc) {
			res.compressionType = FourCcToken.get(buf, off + 18);
			if (this.len > 22) {
				const strLen = UINT8.get(buf, off + 22);
				if (strLen > 0) {
					const padding = (strLen + 1) % 2;
					if (23 + strLen + padding === this.len) res.compressionName = new StringType(strLen, "latin1").get(buf, off + 23);
					else throw new AiffContentError("Illegal pstring length");
				} else res.compressionName = void 0;
			}
		} else res.compressionName = "PCM";
		return res;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/iff/index.js
/**
* Common AIFF chunk header
*/
const Header = {
	len: 8,
	get: (buf, off) => {
		return {
			chunkID: FourCcToken.get(buf, off),
			chunkSize: Number(BigInt(UINT32_BE.get(buf, off + 4)))
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/aiff/AiffParser.js
const debug = (0, import_src.default)("music-metadata:parser:aiff");
/**
* AIFF - Audio Interchange File Format
*
* Ref:
* - http://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/AIFF/AIFF.html
* - http://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/AIFF/Docs/AIFF-1.3.pdf
*/
var AIFFParser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.isCompressed = null;
	}
	async parse() {
		if ((await this.tokenizer.readToken(Header)).chunkID !== "FORM") throw new AiffContentError("Invalid Chunk-ID, expected 'FORM'");
		const type = await this.tokenizer.readToken(FourCcToken);
		switch (type) {
			case "AIFF":
				this.metadata.setFormat("container", type);
				this.isCompressed = false;
				break;
			case "AIFC":
				this.metadata.setFormat("container", "AIFF-C");
				this.isCompressed = true;
				break;
			default: throw new AiffContentError(`Unsupported AIFF type: ${type}`);
		}
		this.metadata.setFormat("lossless", !this.isCompressed);
		this.metadata.setAudioOnly();
		try {
			while (!this.tokenizer.fileInfo.size || this.tokenizer.fileInfo.size - this.tokenizer.position >= Header.len) {
				debug(`Reading AIFF chunk at offset=${this.tokenizer.position}`);
				const chunkHeader = await this.tokenizer.readToken(Header);
				const nextChunk = 2 * Math.round(chunkHeader.chunkSize / 2);
				const bytesRead = await this.readData(chunkHeader);
				await this.tokenizer.ignore(nextChunk - bytesRead);
			}
		} catch (err) {
			if (err instanceof EndOfStreamError) debug("End-of-stream");
			else throw err;
		}
	}
	async readData(header) {
		switch (header.chunkID) {
			case "COMM": {
				if (this.isCompressed === null) throw new AiffContentError("Failed to parse AIFF.COMM chunk when compression type is unknown");
				const common = await this.tokenizer.readToken(new Common(header, this.isCompressed));
				this.metadata.setFormat("bitsPerSample", common.sampleSize);
				this.metadata.setFormat("sampleRate", common.sampleRate);
				this.metadata.setFormat("numberOfChannels", common.numChannels);
				this.metadata.setFormat("numberOfSamples", common.numSampleFrames);
				this.metadata.setFormat("duration", common.numSampleFrames / common.sampleRate);
				if (common.compressionName || common.compressionType) this.metadata.setFormat("codec", common.compressionName ?? compressionTypes[common.compressionType]);
				return header.chunkSize;
			}
			case "ID3 ": {
				const rst = fromBuffer(await this.tokenizer.readToken(new Uint8ArrayType(header.chunkSize)));
				await new ID3v2Parser().parse(this.metadata, rst, this.options);
				return header.chunkSize;
			}
			case "SSND":
				if (this.metadata.format.duration) this.metadata.setFormat("bitrate", 8 * header.chunkSize / this.metadata.format.duration);
				return 0;
			case "NAME":
			case "AUTH":
			case "(c) ":
			case "ANNO": return this.readTextChunk(header);
			default:
				debug(`Ignore chunk id=${header.chunkID}, size=${header.chunkSize}`);
				return 0;
		}
	}
	async readTextChunk(header) {
		const values = (await this.tokenizer.readToken(new StringType(header.chunkSize, "ascii"))).split("\0").map((v) => v.trim()).filter((v) => v?.length);
		await Promise.all(values.map((v) => this.metadata.addTag("AIFF", header.chunkID, v)));
		return header.chunkSize;
	}
};
//#endregion
export { AIFFParser };
