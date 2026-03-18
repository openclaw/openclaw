import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { A as textEncode, C as UINT32_LE, D as Uint8ArrayType, _ as StringType, i as InternalParserError, k as textDecode, r as FieldDecodingError, s as makeUnexpectedFileContentError, t as BasicParser, y as UINT16_LE } from "./BasicParser-CrFlghez.js";
import { t as fromBuffer } from "./lib-BPhRo--R.js";
import { i as findZero, t as a2hex } from "./Util-D0u1g-Ih.js";
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/common/FourCC.js
const validFourCC = /^[\x21-\x7e©][\x20-\x7e\x00()]{3}/;
/**
* Token for read FourCC
* Ref: https://en.wikipedia.org/wiki/FourCC
*/
const FourCcToken = {
	len: 4,
	get: (buf, off) => {
		const id = textDecode(buf.subarray(off, off + FourCcToken.len), "latin1");
		if (!id.match(validFourCC)) throw new FieldDecodingError(`FourCC contains invalid characters: ${a2hex(id)} "${id}"`);
		return id;
	},
	put: (buffer, offset, id) => {
		const str = textEncode(id, "latin1");
		if (str.length !== 4) throw new InternalParserError("Invalid length");
		buffer.set(str, offset);
		return offset + 4;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/apev2/APEv2Token.js
const DataType = {
	text_utf8: 0,
	binary: 1,
	external_info: 2,
	reserved: 3
};
/**
* APE_DESCRIPTOR: defines the sizes (and offsets) of all the pieces, as well as the MD5 checksum
*/
const DescriptorParser = {
	len: 52,
	get: (buf, off) => {
		return {
			ID: FourCcToken.get(buf, off),
			version: UINT32_LE.get(buf, off + 4) / 1e3,
			descriptorBytes: UINT32_LE.get(buf, off + 8),
			headerBytes: UINT32_LE.get(buf, off + 12),
			seekTableBytes: UINT32_LE.get(buf, off + 16),
			headerDataBytes: UINT32_LE.get(buf, off + 20),
			apeFrameDataBytes: UINT32_LE.get(buf, off + 24),
			apeFrameDataBytesHigh: UINT32_LE.get(buf, off + 28),
			terminatingDataBytes: UINT32_LE.get(buf, off + 32),
			fileMD5: new Uint8ArrayType(16).get(buf, off + 36)
		};
	}
};
/**
* APE_HEADER: describes all of the necessary information about the APE file
*/
const Header = {
	len: 24,
	get: (buf, off) => {
		return {
			compressionLevel: UINT16_LE.get(buf, off),
			formatFlags: UINT16_LE.get(buf, off + 2),
			blocksPerFrame: UINT32_LE.get(buf, off + 4),
			finalFrameBlocks: UINT32_LE.get(buf, off + 8),
			totalFrames: UINT32_LE.get(buf, off + 12),
			bitsPerSample: UINT16_LE.get(buf, off + 16),
			channel: UINT16_LE.get(buf, off + 18),
			sampleRate: UINT32_LE.get(buf, off + 20)
		};
	}
};
/**
* APE Tag Header/Footer Version 2.0
* TAG: describes all the properties of the file [optional]
*/
const TagFooter = {
	len: 32,
	get: (buf, off) => {
		return {
			ID: new StringType(8, "ascii").get(buf, off),
			version: UINT32_LE.get(buf, off + 8),
			size: UINT32_LE.get(buf, off + 12),
			fields: UINT32_LE.get(buf, off + 16),
			flags: parseTagFlags(UINT32_LE.get(buf, off + 20))
		};
	}
};
/**
* APE Tag v2.0 Item Header
*/
const TagItemHeader = {
	len: 8,
	get: (buf, off) => {
		return {
			size: UINT32_LE.get(buf, off),
			flags: parseTagFlags(UINT32_LE.get(buf, off + 4))
		};
	}
};
function parseTagFlags(flags) {
	return {
		containsHeader: isBitSet(flags, 31),
		containsFooter: isBitSet(flags, 30),
		isHeader: isBitSet(flags, 29),
		readOnly: isBitSet(flags, 0),
		dataType: (flags & 6) >> 1
	};
}
/**
* @param num {number}
* @param bit 0 is least significant bit (LSB)
* @return {boolean} true if bit is 1; otherwise false
*/
function isBitSet(num, bit) {
	return (num & 1 << bit) !== 0;
}
const debug = (0, (/* @__PURE__ */ __toESM(require_src(), 1)).default)("music-metadata:parser:APEv2");
const tagFormat = "APEv2";
const preamble = "APETAGEX";
var ApeContentError = class extends makeUnexpectedFileContentError("APEv2") {};
function tryParseApeHeader(metadata, tokenizer, options) {
	return new APEv2Parser(metadata, tokenizer, options).tryParseApeHeader();
}
var APEv2Parser = class APEv2Parser extends BasicParser {
	constructor() {
		super(...arguments);
		this.ape = {};
	}
	/**
	* Calculate the media file duration
	* @param ah ApeHeader
	* @return {number} duration in seconds
	*/
	static calculateDuration(ah) {
		let duration = ah.totalFrames > 1 ? ah.blocksPerFrame * (ah.totalFrames - 1) : 0;
		duration += ah.finalFrameBlocks;
		return duration / ah.sampleRate;
	}
	/**
	* Calculates the APEv1 / APEv2 first field offset
	* @param tokenizer
	* @param offset
	*/
	static async findApeFooterOffset(tokenizer, offset) {
		const apeBuf = new Uint8Array(TagFooter.len);
		const position = tokenizer.position;
		if (offset <= TagFooter.len) {
			debug(`Offset is too small to read APE footer: offset=${offset}`);
			return;
		}
		if (offset > TagFooter.len) {
			await tokenizer.readBuffer(apeBuf, { position: offset - TagFooter.len });
			tokenizer.setPosition(position);
			const tagFooter = TagFooter.get(apeBuf, 0);
			if (tagFooter.ID === "APETAGEX") {
				if (tagFooter.flags.isHeader) debug(`APE Header found at offset=${offset - TagFooter.len}`);
				else {
					debug(`APE Footer found at offset=${offset - TagFooter.len}`);
					offset -= tagFooter.size;
				}
				return {
					footer: tagFooter,
					offset
				};
			}
		}
	}
	static parseTagFooter(metadata, buffer, options) {
		const footer = TagFooter.get(buffer, buffer.length - TagFooter.len);
		if (footer.ID !== preamble) throw new ApeContentError("Unexpected APEv2 Footer ID preamble value");
		fromBuffer(buffer);
		return new APEv2Parser(metadata, fromBuffer(buffer), options).parseTags(footer);
	}
	/**
	* Parse APEv1 / APEv2 header if header signature found
	*/
	async tryParseApeHeader() {
		if (this.tokenizer.fileInfo.size && this.tokenizer.fileInfo.size - this.tokenizer.position < TagFooter.len) {
			debug("No APEv2 header found, end-of-file reached");
			return;
		}
		const footer = await this.tokenizer.peekToken(TagFooter);
		if (footer.ID === preamble) {
			await this.tokenizer.ignore(TagFooter.len);
			return this.parseTags(footer);
		}
		debug(`APEv2 header not found at offset=${this.tokenizer.position}`);
		if (this.tokenizer.fileInfo.size) {
			const remaining = this.tokenizer.fileInfo.size - this.tokenizer.position;
			const buffer = new Uint8Array(remaining);
			await this.tokenizer.readBuffer(buffer);
			return APEv2Parser.parseTagFooter(this.metadata, buffer, this.options);
		}
	}
	async parse() {
		const descriptor = await this.tokenizer.readToken(DescriptorParser);
		if (descriptor.ID !== "MAC ") throw new ApeContentError("Unexpected descriptor ID");
		this.ape.descriptor = descriptor;
		const lenExp = descriptor.descriptorBytes - DescriptorParser.len;
		const header = await (lenExp > 0 ? this.parseDescriptorExpansion(lenExp) : this.parseHeader());
		this.metadata.setAudioOnly();
		await this.tokenizer.ignore(header.forwardBytes);
		return this.tryParseApeHeader();
	}
	async parseTags(footer) {
		const keyBuffer = new Uint8Array(256);
		let bytesRemaining = footer.size - TagFooter.len;
		debug(`Parse APE tags at offset=${this.tokenizer.position}, size=${bytesRemaining}`);
		for (let i = 0; i < footer.fields; i++) {
			if (bytesRemaining < TagItemHeader.len) {
				this.metadata.addWarning(`APEv2 Tag-header: ${footer.fields - i} items remaining, but no more tag data to read.`);
				break;
			}
			const tagItemHeader = await this.tokenizer.readToken(TagItemHeader);
			bytesRemaining -= TagItemHeader.len + tagItemHeader.size;
			await this.tokenizer.peekBuffer(keyBuffer, { length: Math.min(keyBuffer.length, bytesRemaining) });
			let zero = findZero(keyBuffer);
			const key = await this.tokenizer.readToken(new StringType(zero, "ascii"));
			await this.tokenizer.ignore(1);
			bytesRemaining -= key.length + 1;
			switch (tagItemHeader.flags.dataType) {
				case DataType.text_utf8: {
					const values = (await this.tokenizer.readToken(new StringType(tagItemHeader.size, "utf8"))).split(/\x00/g);
					await Promise.all(values.map((val) => this.metadata.addTag(tagFormat, key, val)));
					break;
				}
				case DataType.binary:
					if (this.options.skipCovers) await this.tokenizer.ignore(tagItemHeader.size);
					else {
						const picData = new Uint8Array(tagItemHeader.size);
						await this.tokenizer.readBuffer(picData);
						zero = findZero(picData);
						const description = textDecode(picData.subarray(0, zero), "utf-8");
						const data = picData.subarray(zero + 1);
						await this.metadata.addTag(tagFormat, key, {
							description,
							data
						});
					}
					break;
				case DataType.external_info:
					debug(`Ignore external info ${key}`);
					await this.tokenizer.ignore(tagItemHeader.size);
					break;
				case DataType.reserved:
					debug(`Ignore external info ${key}`);
					this.metadata.addWarning(`APEv2 header declares a reserved datatype for "${key}"`);
					await this.tokenizer.ignore(tagItemHeader.size);
					break;
			}
		}
	}
	async parseDescriptorExpansion(lenExp) {
		await this.tokenizer.ignore(lenExp);
		return this.parseHeader();
	}
	async parseHeader() {
		const header = await this.tokenizer.readToken(Header);
		this.metadata.setFormat("lossless", true);
		this.metadata.setFormat("container", "Monkey's Audio");
		this.metadata.setFormat("bitsPerSample", header.bitsPerSample);
		this.metadata.setFormat("sampleRate", header.sampleRate);
		this.metadata.setFormat("numberOfChannels", header.channel);
		this.metadata.setFormat("duration", APEv2Parser.calculateDuration(header));
		if (!this.ape.descriptor) throw new ApeContentError("Missing APE descriptor");
		return { forwardBytes: this.ape.descriptor.seekTableBytes + this.ape.descriptor.headerDataBytes + this.ape.descriptor.apeFrameDataBytes + this.ape.descriptor.terminatingDataBytes };
	}
};
//#endregion
export { FourCcToken as i, ApeContentError as n, tryParseApeHeader as r, APEv2Parser as t };
