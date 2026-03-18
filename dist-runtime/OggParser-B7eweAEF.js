import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, D as Uint8ArrayType, E as UINT8, T as UINT64_LE, _ as StringType, b as UINT24_BE, p as INT32_LE, s as makeUnexpectedFileContentError, t as BasicParser, v as UINT16_BE, y as UINT16_LE } from "./BasicParser-CrFlghez.js";
import { n as EndOfStreamError } from "./lib-BPhRo--R.js";
import { a as getBit, u as trimRightNull } from "./Util-D0u1g-Ih.js";
import { i as FourCcToken } from "./APEv2Parser-CGbu4tbE.js";
import { a as VorbisStream, i as BlockType, n as BlockHeader, o as VorbisPictureToken, r as BlockStreamInfo, t as FlacParser } from "./FlacParser-krYolGKf.js";
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/opus/Opus.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
var OpusContentError = class extends makeUnexpectedFileContentError("Opus") {};
/**
* Opus ID Header parser
* Ref: https://wiki.xiph.org/OggOpus#ID_Header
*/
var IdHeader = class {
	constructor(len) {
		if (len < 19) throw new OpusContentError("ID-header-page 0 should be at least 19 bytes long");
		this.len = len;
	}
	get(buf, off) {
		return {
			magicSignature: new StringType(8, "ascii").get(buf, off + 0),
			version: UINT8.get(buf, off + 8),
			channelCount: UINT8.get(buf, off + 9),
			preSkip: UINT16_LE.get(buf, off + 10),
			inputSampleRate: UINT32_LE.get(buf, off + 12),
			outputGain: UINT16_LE.get(buf, off + 16),
			channelMapping: UINT8.get(buf, off + 18)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/opus/OpusStream.js
/**
* Opus parser
* Internet Engineering Task Force (IETF) - RFC 6716
* Used by OggStream
*/
var OpusStream = class extends VorbisStream {
	constructor(metadata, options, tokenizer) {
		super(metadata, options);
		this.idHeader = null;
		this.lastPos = -1;
		this.tokenizer = tokenizer;
		this.durationOnLastPage = true;
	}
	/**
	* Parse first Opus Ogg page
	* @param {IPageHeader} header
	* @param {Uint8Array} pageData
	*/
	parseFirstPage(_header, pageData) {
		this.metadata.setFormat("codec", "Opus");
		this.idHeader = new IdHeader(pageData.length).get(pageData, 0);
		if (this.idHeader.magicSignature !== "OpusHead") throw new OpusContentError("Illegal ogg/Opus magic-signature");
		this.metadata.setFormat("sampleRate", this.idHeader.inputSampleRate);
		this.metadata.setFormat("numberOfChannels", this.idHeader.channelCount);
		this.metadata.setAudioOnly();
	}
	async parseFullPage(pageData) {
		switch (new StringType(8, "ascii").get(pageData, 0)) {
			case "OpusTags":
				await this.parseUserCommentList(pageData, 8);
				this.lastPos = this.tokenizer.position - pageData.length;
				break;
			default: break;
		}
	}
	calculateDuration(enfOfStream) {
		if (this.lastPageHeader && (enfOfStream || this.lastPageHeader.headerType.lastPage) && this.metadata.format.sampleRate && this.lastPageHeader.absoluteGranulePosition >= 0) {
			const pos_48bit = this.lastPageHeader.absoluteGranulePosition - this.idHeader.preSkip;
			this.metadata.setFormat("numberOfSamples", pos_48bit);
			this.metadata.setFormat("duration", pos_48bit / 48e3);
			if (this.lastPos !== -1 && this.tokenizer.fileInfo.size && this.metadata.format.duration) {
				const dataSize = this.tokenizer.fileInfo.size - this.lastPos;
				this.metadata.setFormat("bitrate", 8 * dataSize / this.metadata.format.duration);
			}
		}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/speex/Speex.js
/**
* Speex Header Packet
* Ref: https://www.speex.org/docs/manual/speex-manual/node8.html#SECTION00830000000000000000
*/
const Header = {
	len: 80,
	get: (buf, off) => {
		return {
			speex: new StringType(8, "ascii").get(buf, off + 0),
			version: trimRightNull(new StringType(20, "ascii").get(buf, off + 8)),
			version_id: INT32_LE.get(buf, off + 28),
			header_size: INT32_LE.get(buf, off + 32),
			rate: INT32_LE.get(buf, off + 36),
			mode: INT32_LE.get(buf, off + 40),
			mode_bitstream_version: INT32_LE.get(buf, off + 44),
			nb_channels: INT32_LE.get(buf, off + 48),
			bitrate: INT32_LE.get(buf, off + 52),
			frame_size: INT32_LE.get(buf, off + 56),
			vbr: INT32_LE.get(buf, off + 60),
			frames_per_packet: INT32_LE.get(buf, off + 64),
			extra_headers: INT32_LE.get(buf, off + 68),
			reserved1: INT32_LE.get(buf, off + 72),
			reserved2: INT32_LE.get(buf, off + 76)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/speex/SpeexStream.js
const debug$3 = (0, import_src.default)("music-metadata:parser:ogg:speex");
/**
* Speex, RFC 5574
* Ref:
* - https://www.speex.org/docs/manual/speex-manual/
* - https://tools.ietf.org/html/rfc5574
*/
var SpeexStream = class extends VorbisStream {
	constructor(metadata, options, _tokenizer) {
		super(metadata, options);
	}
	/**
	* Parse first Speex Ogg page
	* @param {IPageHeader} header
	* @param {Uint8Array} pageData
	*/
	parseFirstPage(_header, pageData) {
		debug$3("First Ogg/Speex page");
		const speexHeader = Header.get(pageData, 0);
		this.metadata.setFormat("codec", `Speex ${speexHeader.version}`);
		this.metadata.setFormat("numberOfChannels", speexHeader.nb_channels);
		this.metadata.setFormat("sampleRate", speexHeader.rate);
		if (speexHeader.bitrate !== -1) this.metadata.setFormat("bitrate", speexHeader.bitrate);
		this.metadata.setAudioOnly();
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/theora/Theora.js
/**
* 6.2 Identification Header
* Ref: https://theora.org/doc/Theora.pdf: 6.2 Identification Header Decode
*/
const IdentificationHeader = {
	len: 42,
	get: (buf, off) => {
		return {
			id: new StringType(7, "ascii").get(buf, off),
			vmaj: UINT8.get(buf, off + 7),
			vmin: UINT8.get(buf, off + 8),
			vrev: UINT8.get(buf, off + 9),
			vmbw: UINT16_BE.get(buf, off + 10),
			vmbh: UINT16_BE.get(buf, off + 17),
			nombr: UINT24_BE.get(buf, off + 37),
			nqual: UINT8.get(buf, off + 40)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/theora/TheoraStream.js
const debug$2 = (0, import_src.default)("music-metadata:parser:ogg:theora");
/**
* Ref:
* - https://theora.org/doc/Theora.pdf
*/
var TheoraStream = class {
	constructor(metadata, _options, _tokenizer) {
		this.durationOnLastPage = false;
		this.metadata = metadata;
	}
	/**
	* Vorbis 1 parser
	* @param header Ogg Page Header
	* @param pageData Page data
	*/
	async parsePage(header, pageData) {
		if (header.headerType.firstPage) await this.parseFirstPage(header, pageData);
	}
	calculateDuration() {
		debug$2("duration calculation not implemented");
	}
	/**
	* Parse first Theora Ogg page. the initial identification header packet
	*/
	async parseFirstPage(_header, pageData) {
		debug$2("First Ogg/Theora page");
		this.metadata.setFormat("codec", "Theora");
		const idHeader = IdentificationHeader.get(pageData, 0);
		this.metadata.setFormat("bitrate", idHeader.nombr);
		this.metadata.setFormat("hasVideo", true);
	}
	flush() {
		return Promise.resolve();
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/OggToken.js
const PageHeader = {
	len: 27,
	get: (buf, off) => {
		return {
			capturePattern: new StringType(4, "latin1").get(buf, off),
			version: UINT8.get(buf, off + 4),
			headerType: {
				continued: getBit(buf, off + 5, 0),
				firstPage: getBit(buf, off + 5, 1),
				lastPage: getBit(buf, off + 5, 2)
			},
			absoluteGranulePosition: Number(UINT64_LE.get(buf, off + 6)),
			streamSerialNumber: UINT32_LE.get(buf, off + 14),
			pageSequenceNo: UINT32_LE.get(buf, off + 18),
			pageChecksum: UINT32_LE.get(buf, off + 22),
			page_segments: UINT8.get(buf, off + 26)
		};
	}
};
var SegmentTable = class SegmentTable {
	static sum(buf, off, len) {
		const dv = new DataView(buf.buffer, 0);
		let s = 0;
		for (let i = off; i < off + len; ++i) s += dv.getUint8(i);
		return s;
	}
	constructor(header) {
		this.len = header.page_segments;
	}
	get(buf, off) {
		return { totalPageSize: SegmentTable.sum(buf, off, this.len) };
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/flac/FlacStream.js
const debug$1 = (0, import_src.default)("music-metadata:parser:ogg:theora");
/**
* Ref:
* - https://xiph.org/flac/ogg_mapping.html
*/
var FlacStream = class {
	constructor(metadata, options, tokenizer) {
		this.durationOnLastPage = false;
		this.metadata = metadata;
		this.options = options;
		this.tokenizer = tokenizer;
		this.flacParser = new FlacParser(this.metadata, this.tokenizer, options);
	}
	/**
	* Vorbis 1 parser
	* @param header Ogg Page Header
	* @param pageData Page data
	*/
	async parsePage(header, pageData) {
		if (header.headerType.firstPage) await this.parseFirstPage(header, pageData);
	}
	calculateDuration() {
		debug$1("duration calculation not implemented");
	}
	/**
	* Parse first Theora Ogg page. the initial identification header packet
	*/
	async parseFirstPage(_header, pageData) {
		debug$1("First Ogg/FLAC page");
		if ((await FourCcToken.get(pageData, 9)).toString() !== "fLaC") throw new Error("Invalid FLAC preamble");
		const blockHeader = await BlockHeader.get(pageData, 13);
		await this.parseDataBlock(blockHeader, pageData.subarray(13 + BlockHeader.len));
	}
	async parseDataBlock(blockHeader, pageData) {
		debug$1(`blockHeader type=${blockHeader.type}, length=${blockHeader.length}`);
		switch (blockHeader.type) {
			case BlockType.STREAMINFO: {
				const streamInfo = BlockStreamInfo.get(pageData, 0);
				return this.flacParser.processsStreamInfo(streamInfo);
			}
			case BlockType.PADDING: break;
			case BlockType.APPLICATION: break;
			case BlockType.SEEKTABLE: break;
			case BlockType.VORBIS_COMMENT: return this.flacParser.parseComment(pageData);
			case BlockType.PICTURE:
				if (!this.options.skipCovers) {
					const picture = new VorbisPictureToken(pageData.length).get(pageData, 0);
					return this.flacParser.addPictureTag(picture);
				}
				break;
			default: this.metadata.addWarning(`Unknown block type: ${blockHeader.type}`);
		}
		return this.tokenizer.ignore(blockHeader.length).then();
	}
	flush() {
		return Promise.resolve();
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/ogg/OggParser.js
var OggContentError = class extends makeUnexpectedFileContentError("Ogg") {};
const debug = (0, import_src.default)("music-metadata:parser:ogg");
var OggStream = class {
	constructor(metadata, streamSerial, options) {
		this.pageNumber = 0;
		this.closed = false;
		this.metadata = metadata;
		this.streamSerial = streamSerial;
		this.options = options;
	}
	async parsePage(tokenizer, header) {
		this.pageNumber = header.pageSequenceNo;
		debug("serial=%s page#=%s, Ogg.id=%s", header.streamSerialNumber, header.pageSequenceNo, header.capturePattern);
		const segmentTable = await tokenizer.readToken(new SegmentTable(header));
		debug("totalPageSize=%s", segmentTable.totalPageSize);
		const pageData = await tokenizer.readToken(new Uint8ArrayType(segmentTable.totalPageSize));
		debug("firstPage=%s, lastPage=%s, continued=%s", header.headerType.firstPage, header.headerType.lastPage, header.headerType.continued);
		if (header.headerType.firstPage) {
			this.metadata.setFormat("container", "Ogg");
			const idData = pageData.subarray(0, 7);
			const asciiId = Array.from(idData).filter((b) => b >= 32 && b <= 126).map((b) => String.fromCharCode(b)).join("");
			switch (asciiId) {
				case "vorbis":
					debug(`Set Ogg stream serial ${header.streamSerialNumber}, codec=Vorbis`);
					this.pageConsumer = new VorbisStream(this.metadata, this.options);
					break;
				case "OpusHea":
					debug("Set page consumer to Ogg/Opus");
					this.pageConsumer = new OpusStream(this.metadata, this.options, tokenizer);
					break;
				case "Speex  ":
					debug("Set page consumer to Ogg/Speex");
					this.pageConsumer = new SpeexStream(this.metadata, this.options, tokenizer);
					break;
				case "fishead":
				case "theora":
					debug("Set page consumer to Ogg/Theora");
					this.pageConsumer = new TheoraStream(this.metadata, this.options, tokenizer);
					break;
				case "FLAC":
					debug("Set page consumer to Vorbis");
					this.pageConsumer = new FlacStream(this.metadata, this.options, tokenizer);
					break;
				default: throw new OggContentError(`Ogg codec not recognized (id=${asciiId}`);
			}
		}
		if (header.headerType.lastPage) this.closed = true;
		if (this.pageConsumer) await this.pageConsumer.parsePage(header, pageData);
		else throw new Error("pageConsumer should be initialized");
	}
};
/**
* Parser for Ogg logical bitstream framing
*/
var OggParser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.streams = /* @__PURE__ */ new Map();
	}
	/**
	* Parse page
	* @returns {Promise<void>}
	*/
	async parse() {
		this.streams = /* @__PURE__ */ new Map();
		let enfOfStream = false;
		let header;
		try {
			do {
				header = await this.tokenizer.readToken(PageHeader);
				if (header.capturePattern !== "OggS") throw new OggContentError("Invalid Ogg capture pattern");
				let stream = this.streams.get(header.streamSerialNumber);
				if (!stream) {
					stream = new OggStream(this.metadata, header.streamSerialNumber, this.options);
					this.streams.set(header.streamSerialNumber, stream);
				}
				await stream.parsePage(this.tokenizer, header);
				if (stream.pageNumber > 12 && !(this.options.duration && [...this.streams.values()].find((stream) => stream.pageConsumer?.durationOnLastPage))) {
					debug("Stop processing Ogg stream");
					break;
				}
			} while (![...this.streams.values()].every((item) => item.closed));
		} catch (err) {
			if (err instanceof EndOfStreamError) {
				debug("Reached end-of-stream");
				enfOfStream = true;
			} else if (err instanceof OggContentError) this.metadata.addWarning(`Corrupt Ogg content at ${this.tokenizer.position}`);
			else throw err;
		}
		for (const stream of this.streams.values()) {
			if (!stream.closed) {
				this.metadata.addWarning(`End-of-stream reached before reaching last page in Ogg stream serial=${stream.streamSerial}`);
				await stream.pageConsumer?.flush();
			}
			stream.pageConsumer?.calculateDuration(enfOfStream);
		}
	}
};
//#endregion
export { OggParser };
