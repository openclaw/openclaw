import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, D as Uint8ArrayType, E as UINT8, S as UINT32_BE, _ as StringType, b as UINT24_BE, k as textDecode, s as makeUnexpectedFileContentError, v as UINT16_BE } from "./BasicParser-CJDqseT1.js";
import { a as getBit, o as getBitAllignedNumber } from "./Util-C3ovgFZT.js";
import { t as AttachedPictureType } from "./ID3v2Token-BPbBfqkQ.js";
import { i as FourCcToken } from "./APEv2Parser-C7cXS6nR.js";
import { t as AbstractID3Parser } from "./AbstractID3Parser-C5eAXTeT.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/ogg/vorbis/Vorbis.js
/**
* Parse the METADATA_BLOCK_PICTURE
* Ref: https://wiki.xiph.org/VorbisComment#METADATA_BLOCK_PICTURE
* Ref: https://xiph.org/flac/format.html#metadata_block_picture
* // ToDo: move to ID3 / APIC?
*/
var VorbisPictureToken = class VorbisPictureToken {
	static fromBase64(base64str) {
		return VorbisPictureToken.fromBuffer(Uint8Array.from(atob(base64str), (c) => c.charCodeAt(0)));
	}
	static fromBuffer(buffer) {
		return new VorbisPictureToken(buffer.length).get(buffer, 0);
	}
	constructor(len) {
		this.len = len;
	}
	get(buffer, offset) {
		const type = AttachedPictureType[UINT32_BE.get(buffer, offset)];
		offset += 4;
		const mimeLen = UINT32_BE.get(buffer, offset);
		offset += 4;
		const format = new StringType(mimeLen, "utf-8").get(buffer, offset);
		offset += mimeLen;
		const descLen = UINT32_BE.get(buffer, offset);
		offset += 4;
		const description = new StringType(descLen, "utf-8").get(buffer, offset);
		offset += descLen;
		const width = UINT32_BE.get(buffer, offset);
		offset += 4;
		const height = UINT32_BE.get(buffer, offset);
		offset += 4;
		const colour_depth = UINT32_BE.get(buffer, offset);
		offset += 4;
		const indexed_color = UINT32_BE.get(buffer, offset);
		offset += 4;
		const picDataLen = UINT32_BE.get(buffer, offset);
		offset += 4;
		return {
			type,
			format,
			description,
			width,
			height,
			colour_depth,
			indexed_color,
			data: buffer.slice(offset, offset + picDataLen)
		};
	}
};
/**
* Comment header decoder
* Ref: https://xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-620004.2.1
*/
const CommonHeader = {
	len: 7,
	get: (buf, off) => {
		return {
			packetType: UINT8.get(buf, off),
			vorbis: new StringType(6, "ascii").get(buf, off + 1)
		};
	}
};
/**
* Identification header decoder
* Ref: https://xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-630004.2.2
*/
const IdentificationHeader = {
	len: 23,
	get: (uint8Array, off) => {
		return {
			version: UINT32_LE.get(uint8Array, off + 0),
			channelMode: UINT8.get(uint8Array, off + 4),
			sampleRate: UINT32_LE.get(uint8Array, off + 5),
			bitrateMax: UINT32_LE.get(uint8Array, off + 9),
			bitrateNominal: UINT32_LE.get(uint8Array, off + 13),
			bitrateMin: UINT32_LE.get(uint8Array, off + 17)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/ogg/vorbis/VorbisDecoder.js
var VorbisDecoder = class {
	constructor(data, offset) {
		this.data = data;
		this.offset = offset;
	}
	readInt32() {
		const value = UINT32_LE.get(this.data, this.offset);
		this.offset += 4;
		return value;
	}
	readStringUtf8() {
		const len = this.readInt32();
		const value = textDecode(this.data.subarray(this.offset, this.offset + len), "utf-8");
		this.offset += len;
		return value;
	}
	parseUserComment() {
		const offset0 = this.offset;
		const v = this.readStringUtf8();
		const idx = v.indexOf("=");
		return {
			key: v.substring(0, idx).toUpperCase(),
			value: v.substring(idx + 1),
			len: this.offset - offset0
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/ogg/vorbis/VorbisStream.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
const debug$1 = (0, import_src.default)("music-metadata:parser:ogg:vorbis1");
var VorbisContentError = class extends makeUnexpectedFileContentError("Vorbis") {};
/**
* Vorbis 1 Parser.
* Used by OggStream
*/
var VorbisStream = class VorbisStream {
	constructor(metadata, options) {
		this.pageSegments = [];
		this.durationOnLastPage = true;
		this.metadata = metadata;
		this.options = options;
	}
	/**
	* Vorbis 1 parser
	* @param header Ogg Page Header
	* @param pageData Page data
	*/
	async parsePage(header, pageData) {
		this.lastPageHeader = header;
		if (header.headerType.firstPage) {this.parseFirstPage(header, pageData);}
		else {
			if (header.headerType.continued) {
				if (this.pageSegments.length === 0) {throw new VorbisContentError("Cannot continue on previous page");}
				this.pageSegments.push(pageData);
			}
			if (header.headerType.lastPage || !header.headerType.continued) {
				if (this.pageSegments.length > 0) {
					const fullPage = VorbisStream.mergeUint8Arrays(this.pageSegments);
					await this.parseFullPage(fullPage);
				}
				this.pageSegments = header.headerType.lastPage ? [] : [pageData];
			}
		}
	}
	static mergeUint8Arrays(arrays) {
		const totalSize = arrays.reduce((acc, e) => acc + e.length, 0);
		const merged = new Uint8Array(totalSize);
		arrays.forEach((array, i, _arrays) => {
			const offset = _arrays.slice(0, i).reduce((acc, e) => acc + e.length, 0);
			merged.set(array, offset);
		});
		return merged;
	}
	async flush() {
		await this.parseFullPage(VorbisStream.mergeUint8Arrays(this.pageSegments));
	}
	async parseUserComment(pageData, offset) {
		const tag = new VorbisDecoder(pageData, offset).parseUserComment();
		await this.addTag(tag.key, tag.value);
		return tag.len;
	}
	async addTag(id, value) {
		if (id === "METADATA_BLOCK_PICTURE" && typeof value === "string") {
			if (this.options.skipCovers) {
				debug$1("Ignore picture");
				return;
			}
			value = VorbisPictureToken.fromBase64(value);
			debug$1(`Push picture: id=${id}, format=${value.format}`);
		} else {debug$1(`Push tag: id=${id}, value=${value}`);}
		await this.metadata.addTag("vorbis", id, value);
	}
	calculateDuration(enfOfStream) {
		if (this.lastPageHeader && (enfOfStream || this.lastPageHeader.headerType.lastPage) && this.metadata.format.sampleRate && this.lastPageHeader.absoluteGranulePosition >= 0) {
			this.metadata.setFormat("numberOfSamples", this.lastPageHeader.absoluteGranulePosition);
			this.metadata.setFormat("duration", this.lastPageHeader.absoluteGranulePosition / this.metadata.format.sampleRate);
		}
	}
	/**
	* Parse first Ogg/Vorbis page
	* @param _header
	* @param pageData
	*/
	parseFirstPage(_header, pageData) {
		this.metadata.setFormat("codec", "Vorbis I");
		this.metadata.setFormat("hasAudio", true);
		debug$1("Parse first page");
		const commonHeader = CommonHeader.get(pageData, 0);
		if (commonHeader.vorbis !== "vorbis") {throw new VorbisContentError("Metadata does not look like Vorbis");}
		if (commonHeader.packetType === 1) {
			const idHeader = IdentificationHeader.get(pageData, CommonHeader.len);
			this.metadata.setFormat("sampleRate", idHeader.sampleRate);
			this.metadata.setFormat("bitrate", idHeader.bitrateNominal);
			this.metadata.setFormat("numberOfChannels", idHeader.channelMode);
			debug$1("sample-rate=%s[hz], bitrate=%s[b/s], channel-mode=%s", idHeader.sampleRate, idHeader.bitrateNominal, idHeader.channelMode);
		} else {throw new VorbisContentError("First Ogg page should be type 1: the identification header");}
	}
	async parseFullPage(pageData) {
		const commonHeader = CommonHeader.get(pageData, 0);
		debug$1("Parse full page: type=%s, byteLength=%s", commonHeader.packetType, pageData.byteLength);
		switch (commonHeader.packetType) {
			case 3: return this.parseUserCommentList(pageData, CommonHeader.len);
			case 1:
			case 5: break;
		}
	}
	/**
	* Ref: https://xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-840005.2
	*/
	async parseUserCommentList(pageData, offset) {
		const strLen = UINT32_LE.get(pageData, offset);
		offset += 4;
		offset += strLen;
		let userCommentListLength = UINT32_LE.get(pageData, offset);
		offset += 4;
		while (userCommentListLength-- > 0) {offset += await this.parseUserComment(pageData, offset);}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/flac/FlacToken.js
/**
* FLAC supports up to 128 kinds of metadata blocks; currently the following are defined:
* ref: https://xiph.org/flac/format.html#metadata_block
*/
const BlockType = {
	STREAMINFO: 0,
	PADDING: 1,
	APPLICATION: 2,
	SEEKTABLE: 3,
	VORBIS_COMMENT: 4,
	CUESHEET: 5,
	PICTURE: 6
};
const BlockHeader = {
	len: 4,
	get: (buf, off) => {
		return {
			lastBlock: getBit(buf, off, 7),
			type: getBitAllignedNumber(buf, off, 1, 7),
			length: UINT24_BE.get(buf, off + 1)
		};
	}
};
/**
* METADATA_BLOCK_DATA
* Ref: https://xiph.org/flac/format.html#metadata_block_streaminfo
*/
const BlockStreamInfo = {
	len: 34,
	get: (buf, off) => {
		return {
			minimumBlockSize: UINT16_BE.get(buf, off),
			maximumBlockSize: UINT16_BE.get(buf, off + 2) / 1e3,
			minimumFrameSize: UINT24_BE.get(buf, off + 4),
			maximumFrameSize: UINT24_BE.get(buf, off + 7),
			sampleRate: UINT24_BE.get(buf, off + 10) >> 4,
			channels: getBitAllignedNumber(buf, off + 12, 4, 3) + 1,
			bitsPerSample: getBitAllignedNumber(buf, off + 12, 7, 5) + 1,
			totalSamples: getBitAllignedNumber(buf, off + 13, 4, 36),
			fileMD5: new Uint8ArrayType(16).get(buf, off + 18)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/flac/FlacParser.js
const debug = (0, import_src.default)("music-metadata:parser:FLAC");
var FlacContentError = class extends makeUnexpectedFileContentError("FLAC") {};
var FlacParser = class extends AbstractID3Parser {
	constructor() {
		super(...arguments);
		this.vorbisParser = new VorbisStream(this.metadata, this.options);
	}
	async postId3v2Parse() {
		if ((await this.tokenizer.readToken(FourCcToken)).toString() !== "fLaC") {throw new FlacContentError("Invalid FLAC preamble");}
		let blockHeader;
		do {
			blockHeader = await this.tokenizer.readToken(BlockHeader);
			await this.parseDataBlock(blockHeader);
		} while (!blockHeader.lastBlock);
		if (this.tokenizer.fileInfo.size && this.metadata.format.duration) {
			const dataSize = this.tokenizer.fileInfo.size - this.tokenizer.position;
			this.metadata.setFormat("bitrate", 8 * dataSize / this.metadata.format.duration);
		}
	}
	async parseDataBlock(blockHeader) {
		debug(`blockHeader type=${blockHeader.type}, length=${blockHeader.length}`);
		switch (blockHeader.type) {
			case BlockType.STREAMINFO: return this.readBlockStreamInfo(blockHeader.length);
			case BlockType.PADDING: break;
			case BlockType.APPLICATION: break;
			case BlockType.SEEKTABLE: break;
			case BlockType.VORBIS_COMMENT: return this.readComment(blockHeader.length);
			case BlockType.CUESHEET: break;
			case BlockType.PICTURE:
				await this.parsePicture(blockHeader.length);
				return;
			default: this.metadata.addWarning(`Unknown block type: ${blockHeader.type}`);
		}
		return this.tokenizer.ignore(blockHeader.length).then();
	}
	/**
	* Parse STREAMINFO
	*/
	async readBlockStreamInfo(dataLen) {
		if (dataLen !== BlockStreamInfo.len) {throw new FlacContentError("Unexpected block-stream-info length");}
		const streamInfo = await this.tokenizer.readToken(BlockStreamInfo);
		this.metadata.setFormat("container", "FLAC");
		this.processsStreamInfo(streamInfo);
	}
	/**
	* Parse STREAMINFO
	*/
	processsStreamInfo(streamInfo) {
		this.metadata.setFormat("codec", "FLAC");
		this.metadata.setFormat("hasAudio", true);
		this.metadata.setFormat("lossless", true);
		this.metadata.setFormat("numberOfChannels", streamInfo.channels);
		this.metadata.setFormat("bitsPerSample", streamInfo.bitsPerSample);
		this.metadata.setFormat("sampleRate", streamInfo.sampleRate);
		if (streamInfo.totalSamples > 0) {this.metadata.setFormat("duration", streamInfo.totalSamples / streamInfo.sampleRate);}
	}
	/**
	* Read VORBIS_COMMENT from tokenizer
	* Ref: https://www.xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-640004.2.3
	*/
	async readComment(dataLen) {
		const data = await this.tokenizer.readToken(new Uint8ArrayType(dataLen));
		return this.parseComment(data);
	}
	/**
	* Parse VORBIS_COMMENT
	* Ref: https://www.xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-640004.2.3
	*/
	async parseComment(data) {
		const decoder = new VorbisDecoder(data, 0);
		const vendor = decoder.readStringUtf8();
		if (vendor.length > 0) {this.metadata.setFormat("tool", vendor);}
		const commentListLength = decoder.readInt32();
		const tags = new Array(commentListLength);
		for (let i = 0; i < commentListLength; i++) {tags[i] = decoder.parseUserComment();}
		await Promise.all(tags.map((tag) => {
			if (tag.key === "ENCODER") {this.metadata.setFormat("tool", tag.value);}
			return this.addTag(tag.key, tag.value);
		}));
	}
	async parsePicture(dataLen) {
		if (this.options.skipCovers) {return this.tokenizer.ignore(dataLen);}
		return this.addPictureTag(await this.tokenizer.readToken(new VorbisPictureToken(dataLen)));
	}
	addPictureTag(picture) {
		return this.addTag("METADATA_BLOCK_PICTURE", picture);
	}
	addTag(id, value) {
		return this.vorbisParser.addTag(id, value);
	}
};
//#endregion
export { VorbisStream as a, BlockType as i, BlockHeader as n, VorbisPictureToken as o, BlockStreamInfo as r, FlacParser as t };
