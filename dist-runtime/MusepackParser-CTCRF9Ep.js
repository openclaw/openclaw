import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, E as UINT8, _ as StringType, k as textDecode, s as makeUnexpectedFileContentError, t as BasicParser, y as UINT16_LE } from "./BasicParser-CJDqseT1.js";
import "./lib-BPhRo--R.js";
import { o as getBitAllignedNumber, s as isBitSet } from "./Util-C3ovgFZT.js";
import { i as FourCcToken, r as tryParseApeHeader } from "./APEv2Parser-C7cXS6nR.js";
import { t as AbstractID3Parser } from "./AbstractID3Parser-C5eAXTeT.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/sv8/StreamVersion8.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
const debug$3 = (0, import_src.default)("music-metadata:parser:musepack:sv8");
const PacketKey = new StringType(2, "latin1");
/**
* Stream Header Packet part 1
* Ref: http://trac.musepack.net/musepack/wiki/SV8Specification#StreamHeaderPacket
*/
const SH_part1 = {
	len: 5,
	get: (buf, off) => {
		return {
			crc: UINT32_LE.get(buf, off),
			streamVersion: UINT8.get(buf, off + 4)
		};
	}
};
/**
* Stream Header Packet part 3
* Ref: http://trac.musepack.net/musepack/wiki/SV8Specification#StreamHeaderPacket
*/
const SH_part3 = {
	len: 2,
	get: (buf, off) => {
		return {
			sampleFrequency: [
				44100,
				48e3,
				37800,
				32e3
			][getBitAllignedNumber(buf, off, 0, 3)],
			maxUsedBands: getBitAllignedNumber(buf, off, 3, 5),
			channelCount: getBitAllignedNumber(buf, off + 1, 0, 4) + 1,
			msUsed: isBitSet(buf, off + 1, 4),
			audioBlockFrames: getBitAllignedNumber(buf, off + 1, 5, 3)
		};
	}
};
var StreamReader = class {
	get tokenizer() {
		return this._tokenizer;
	}
	set tokenizer(value) {
		this._tokenizer = value;
	}
	constructor(_tokenizer) {
		this._tokenizer = _tokenizer;
	}
	async readPacketHeader() {
		const key = await this.tokenizer.readToken(PacketKey);
		const size = await this.readVariableSizeField();
		return {
			key,
			payloadLength: size.value - 2 - size.len
		};
	}
	async readStreamHeader(size) {
		const streamHeader = {};
		debug$3(`Reading SH at offset=${this.tokenizer.position}`);
		const part1 = await this.tokenizer.readToken(SH_part1);
		size -= SH_part1.len;
		Object.assign(streamHeader, part1);
		debug$3(`SH.streamVersion = ${part1.streamVersion}`);
		const sampleCount = await this.readVariableSizeField();
		size -= sampleCount.len;
		streamHeader.sampleCount = sampleCount.value;
		const bs = await this.readVariableSizeField();
		size -= bs.len;
		streamHeader.beginningOfSilence = bs.value;
		const part3 = await this.tokenizer.readToken(SH_part3);
		size -= SH_part3.len;
		Object.assign(streamHeader, part3);
		await this.tokenizer.ignore(size);
		return streamHeader;
	}
	async readVariableSizeField(len = 1, hb = 0) {
		let n = await this.tokenizer.readNumber(UINT8);
		if ((n & 128) === 0) {return {
			len,
			value: hb + n
		};}
		n &= 127;
		n += hb;
		return this.readVariableSizeField(len + 1, n << 7);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/MusepackConentError.js
var MusepackContentError = class extends makeUnexpectedFileContentError("Musepack") {};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/sv8/MpcSv8Parser.js
const debug$2 = (0, import_src.default)("music-metadata:parser:musepack");
var MpcSv8Parser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.audioLength = 0;
	}
	async parse() {
		if (await this.tokenizer.readToken(FourCcToken) !== "MPCK") {throw new MusepackContentError("Invalid Magic number");}
		this.metadata.setFormat("container", "Musepack, SV8");
		return this.parsePacket();
	}
	async parsePacket() {
		const sv8reader = new StreamReader(this.tokenizer);
		do {
			const header = await sv8reader.readPacketHeader();
			debug$2(`packet-header key=${header.key}, payloadLength=${header.payloadLength}`);
			switch (header.key) {
				case "SH": {
					const sh = await sv8reader.readStreamHeader(header.payloadLength);
					this.metadata.setFormat("numberOfSamples", sh.sampleCount);
					this.metadata.setFormat("sampleRate", sh.sampleFrequency);
					this.metadata.setFormat("duration", sh.sampleCount / sh.sampleFrequency);
					this.metadata.setFormat("numberOfChannels", sh.channelCount);
					break;
				}
				case "AP":
					this.audioLength += header.payloadLength;
					await this.tokenizer.ignore(header.payloadLength);
					break;
				case "RG":
				case "EI":
				case "SO":
				case "ST":
				case "CT":
					await this.tokenizer.ignore(header.payloadLength);
					break;
				case "SE":
					if (this.metadata.format.duration) {this.metadata.setFormat("bitrate", this.audioLength * 8 / this.metadata.format.duration);}
					return tryParseApeHeader(this.metadata, this.tokenizer, this.options);
				default: throw new MusepackContentError(`Unexpected header: ${header.key}`);
			}
		} while (true);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/sv7/BitReader.js
var BitReader = class {
	constructor(tokenizer) {
		this.pos = 0;
		this.dword = null;
		this.tokenizer = tokenizer;
	}
	/**
	*
	* @param bits 1..30 bits
	*/
	async read(bits) {
		while (this.dword === null) {this.dword = await this.tokenizer.readToken(UINT32_LE);}
		let out = this.dword;
		this.pos += bits;
		if (this.pos < 32) {
			out >>>= 32 - this.pos;
			return out & (1 << bits) - 1;
		}
		this.pos -= 32;
		if (this.pos === 0) {
			this.dword = null;
			return out & (1 << bits) - 1;
		}
		this.dword = await this.tokenizer.readToken(UINT32_LE);
		if (this.pos) {
			out <<= this.pos;
			out |= this.dword >>> 32 - this.pos;
		}
		return out & (1 << bits) - 1;
	}
	async ignore(bits) {
		if (this.pos > 0) {
			const remaining = 32 - this.pos;
			this.dword = null;
			bits -= remaining;
			this.pos = 0;
		}
		const remainder = bits % 32;
		const numOfWords = (bits - remainder) / 32;
		await this.tokenizer.ignore(numOfWords * 4);
		return this.read(remainder);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/sv7/StreamVersion7.js
/**
* BASIC STRUCTURE
*/
const Header = {
	len: 24,
	get: (buf, off) => {
		const header = {
			signature: textDecode(buf.subarray(off, off + 3), "latin1"),
			streamMinorVersion: getBitAllignedNumber(buf, off + 3, 0, 4),
			streamMajorVersion: getBitAllignedNumber(buf, off + 3, 4, 4),
			frameCount: UINT32_LE.get(buf, off + 4),
			maxLevel: UINT16_LE.get(buf, off + 8),
			sampleFrequency: [
				44100,
				48e3,
				37800,
				32e3
			][getBitAllignedNumber(buf, off + 10, 0, 2)],
			link: getBitAllignedNumber(buf, off + 10, 2, 2),
			profile: getBitAllignedNumber(buf, off + 10, 4, 4),
			maxBand: getBitAllignedNumber(buf, off + 11, 0, 6),
			intensityStereo: isBitSet(buf, off + 11, 6),
			midSideStereo: isBitSet(buf, off + 11, 7),
			titlePeak: UINT16_LE.get(buf, off + 12),
			titleGain: UINT16_LE.get(buf, off + 14),
			albumPeak: UINT16_LE.get(buf, off + 16),
			albumGain: UINT16_LE.get(buf, off + 18),
			lastFrameLength: UINT32_LE.get(buf, off + 20) >>> 20 & 2047,
			trueGapless: isBitSet(buf, off + 23, 0)
		};
		header.lastFrameLength = header.trueGapless ? UINT32_LE.get(buf, 20) >>> 20 & 2047 : 0;
		return header;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/sv7/MpcSv7Parser.js
const debug$1 = (0, import_src.default)("music-metadata:parser:musepack");
var MpcSv7Parser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.bitreader = null;
		this.audioLength = 0;
		this.duration = null;
	}
	async parse() {
		const header = await this.tokenizer.readToken(Header);
		if (header.signature !== "MP+") {throw new MusepackContentError("Unexpected magic number");}
		debug$1(`stream-version=${header.streamMajorVersion}.${header.streamMinorVersion}`);
		this.metadata.setFormat("container", "Musepack, SV7");
		this.metadata.setFormat("sampleRate", header.sampleFrequency);
		const numberOfSamples = 1152 * (header.frameCount - 1) + header.lastFrameLength;
		this.metadata.setFormat("numberOfSamples", numberOfSamples);
		this.duration = numberOfSamples / header.sampleFrequency;
		this.metadata.setFormat("duration", this.duration);
		this.bitreader = new BitReader(this.tokenizer);
		this.metadata.setFormat("numberOfChannels", header.midSideStereo || header.intensityStereo ? 2 : 1);
		const version = await this.bitreader.read(8);
		this.metadata.setFormat("codec", (version / 100).toFixed(2));
		await this.skipAudioData(header.frameCount);
		debug$1(`End of audio stream, switching to APEv2, offset=${this.tokenizer.position}`);
		return tryParseApeHeader(this.metadata, this.tokenizer, this.options);
	}
	async skipAudioData(frameCount) {
		while (frameCount-- > 0) {
			const frameLength = await this.bitreader.read(20);
			this.audioLength += 20 + frameLength;
			await this.bitreader.ignore(frameLength);
		}
		const lastFrameLength = await this.bitreader.read(11);
		this.audioLength += lastFrameLength;
		if (this.duration !== null) {this.metadata.setFormat("bitrate", this.audioLength / this.duration);}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/MusepackParser.js
const debug = (0, import_src.default)("music-metadata:parser:musepack");
var MusepackParser = class extends AbstractID3Parser {
	async postId3v2Parse() {
		const signature = await this.tokenizer.peekToken(new StringType(3, "latin1"));
		let mpcParser;
		switch (signature) {
			case "MP+":
				debug("Stream-version 7");
				mpcParser = new MpcSv7Parser(this.metadata, this.tokenizer, this.options);
				break;
			case "MPC":
				debug("Stream-version 8");
				mpcParser = new MpcSv8Parser(this.metadata, this.tokenizer, this.options);
				break;
			default: throw new MusepackContentError("Invalid signature prefix");
		}
		this.metadata.setAudioOnly();
		return mpcParser.parse();
	}
};
//#endregion
export { MusepackParser };
