import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, D as Uint8ArrayType, E as UINT8, s as makeUnexpectedFileContentError, t as BasicParser, x as UINT24_LE, y as UINT16_LE } from "./BasicParser-CJDqseT1.js";
import "./lib-BPhRo--R.js";
import { d as uint8ArrayToHex } from "./Util-C3ovgFZT.js";
import { i as FourCcToken, r as tryParseApeHeader } from "./APEv2Parser-C7cXS6nR.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/wavpack/WavPackToken.js
const SampleRates = [
	6e3,
	8e3,
	9600,
	11025,
	12e3,
	16e3,
	22050,
	24e3,
	32e3,
	44100,
	48e3,
	64e3,
	88200,
	96e3,
	192e3,
	-1
];
/**
* WavPack Block Header
*
* 32-byte little-endian header at the front of every WavPack block
*
* Ref: http://www.wavpack.com/WavPack5FileFormat.pdf (page 2/6: 2.0 "Block Header")
*/
const BlockHeaderToken = {
	len: 32,
	get: (buf, off) => {
		const flags = UINT32_LE.get(buf, off + 24);
		const res = {
			BlockID: FourCcToken.get(buf, off),
			blockSize: UINT32_LE.get(buf, off + 4),
			version: UINT16_LE.get(buf, off + 8),
			totalSamples: UINT32_LE.get(buf, off + 12),
			blockIndex: UINT32_LE.get(buf, off + 16),
			blockSamples: UINT32_LE.get(buf, off + 20),
			flags: {
				bitsPerSample: (1 + getBitAllignedNumber(flags, 0, 2)) * 8,
				isMono: isBitSet(flags, 2),
				isHybrid: isBitSet(flags, 3),
				isJointStereo: isBitSet(flags, 4),
				crossChannel: isBitSet(flags, 5),
				hybridNoiseShaping: isBitSet(flags, 6),
				floatingPoint: isBitSet(flags, 7),
				samplingRate: SampleRates[getBitAllignedNumber(flags, 23, 4)],
				isDSD: isBitSet(flags, 31)
			},
			crc: new Uint8ArrayType(4).get(buf, off + 28)
		};
		if (res.flags.isDSD) {res.totalSamples *= 8;}
		return res;
	}
};
/**
* 3.0 Metadata Sub-Blocks
* Ref: http://www.wavpack.com/WavPack5FileFormat.pdf (page 4/6: 3.0 "Metadata Sub-Block")
*/
const MetadataIdToken = {
	len: 1,
	get: (buf, off) => {
		return {
			functionId: getBitAllignedNumber(buf[off], 0, 6),
			isOptional: isBitSet(buf[off], 5),
			isOddSize: isBitSet(buf[off], 6),
			largeBlock: isBitSet(buf[off], 7)
		};
	}
};
function isBitSet(flags, bitOffset) {
	return getBitAllignedNumber(flags, bitOffset, 1) === 1;
}
function getBitAllignedNumber(flags, bitOffset, len) {
	return flags >>> bitOffset & 4294967295 >>> 32 - len;
}
const debug = (0, (/* @__PURE__ */ __toESM(require_src(), 1)).default)("music-metadata:parser:WavPack");
var WavPackContentError = class extends makeUnexpectedFileContentError("WavPack") {};
/**
* WavPack Parser
*/
var WavPackParser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.audioDataSize = 0;
	}
	async parse() {
		this.metadata.setAudioOnly();
		this.audioDataSize = 0;
		await this.parseWavPackBlocks();
		return tryParseApeHeader(this.metadata, this.tokenizer, this.options);
	}
	async parseWavPackBlocks() {
		do {
			if (await this.tokenizer.peekToken(FourCcToken) !== "wvpk") {break;}
			const header = await this.tokenizer.readToken(BlockHeaderToken);
			if (header.BlockID !== "wvpk") {throw new WavPackContentError("Invalid WavPack Block-ID");}
			debug(`WavPack header blockIndex=${header.blockIndex}, len=${BlockHeaderToken.len}`);
			if (header.blockIndex === 0 && !this.metadata.format.container) {
				this.metadata.setFormat("container", "WavPack");
				this.metadata.setFormat("lossless", !header.flags.isHybrid);
				this.metadata.setFormat("bitsPerSample", header.flags.bitsPerSample);
				if (!header.flags.isDSD) {
					this.metadata.setFormat("sampleRate", header.flags.samplingRate);
					this.metadata.setFormat("duration", header.totalSamples / header.flags.samplingRate);
				}
				this.metadata.setFormat("numberOfChannels", header.flags.isMono ? 1 : 2);
				this.metadata.setFormat("numberOfSamples", header.totalSamples);
				this.metadata.setFormat("codec", header.flags.isDSD ? "DSD" : "PCM");
			}
			const ignoreBytes = header.blockSize - (BlockHeaderToken.len - 8);
			await (header.blockIndex === 0 ? this.parseMetadataSubBlock(header, ignoreBytes) : this.tokenizer.ignore(ignoreBytes));
			if (header.blockSamples > 0) {this.audioDataSize += header.blockSize;}
		} while (!this.tokenizer.fileInfo.size || this.tokenizer.fileInfo.size - this.tokenizer.position >= BlockHeaderToken.len);
		if (this.metadata.format.duration) {this.metadata.setFormat("bitrate", this.audioDataSize * 8 / this.metadata.format.duration);}
	}
	/**
	* Ref: http://www.wavpack.com/WavPack5FileFormat.pdf, 3.0 Metadata Sub-blocks
	* @param header Header
	* @param remainingLength Remaining length
	*/
	async parseMetadataSubBlock(header, remainingLength) {
		let remaining = remainingLength;
		while (remaining > MetadataIdToken.len) {
			const id = await this.tokenizer.readToken(MetadataIdToken);
			const dataSizeInWords = await this.tokenizer.readNumber(id.largeBlock ? UINT24_LE : UINT8);
			const data = new Uint8Array(dataSizeInWords * 2 - (id.isOddSize ? 1 : 0));
			await this.tokenizer.readBuffer(data);
			debug(`Metadata Sub-Blocks functionId=0x${id.functionId.toString(16)}, id.largeBlock=${id.largeBlock},data-size=${data.length}`);
			switch (id.functionId) {
				case 0: break;
				case 14: {
					debug("ID_DSD_BLOCK");
					const mp = 1 << UINT8.get(data, 0);
					const samplingRate = header.flags.samplingRate * mp * 8;
					if (!header.flags.isDSD) {throw new WavPackContentError("Only expect DSD block if DSD-flag is set");}
					this.metadata.setFormat("sampleRate", samplingRate);
					this.metadata.setFormat("duration", header.totalSamples / samplingRate);
					break;
				}
				case 36:
					debug("ID_ALT_TRAILER: trailer for non-wav files");
					break;
				case 38:
					this.metadata.setFormat("audioMD5", data);
					break;
				case 47:
					debug(`ID_BLOCK_CHECKSUM: checksum=${uint8ArrayToHex(data)}`);
					break;
				default:
					debug(`Ignore unsupported meta-sub-block-id functionId=0x${id.functionId.toString(16)}`);
					break;
			}
			remaining -= MetadataIdToken.len + (id.largeBlock ? UINT24_LE.len : UINT8.len) + dataSizeInWords * 2;
			debug(`remainingLength=${remaining}`);
			if (id.isOddSize) {this.tokenizer.ignore(1);}
		}
		if (remaining !== 0) {throw new WavPackContentError("metadata-sub-block should fit it remaining length");}
	}
};
//#endregion
export { WavPackParser };
