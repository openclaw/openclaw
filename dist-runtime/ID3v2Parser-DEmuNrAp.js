import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { D as Uint8ArrayType, E as UINT8, S as UINT32_BE, b as UINT24_BE, k as textDecode, s as makeUnexpectedFileContentError } from "./BasicParser-CJDqseT1.js";
import { a as getBit, i as findZero, n as decodeString, r as decodeUintBE } from "./Util-C3ovgFZT.js";
import { a as SyncTextHeader, l as UINT32SYNCSAFE, n as ExtendedHeader, o as TextEncodingToken, r as ID3v2Header, s as TextHeader, t as AttachedPictureType } from "./ID3v2Token-BPbBfqkQ.js";
import { t as Genres } from "./ID3v1Parser-BdpkOjEn.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v2/ID3v2ChapterToken.js
/**
* Data portion of `CHAP` sub frame
*/
const ChapterInfo = {
	len: 16,
	get: (buf, off) => {
		const startOffset = UINT32_BE.get(buf, off + 8);
		const endOffset = UINT32_BE.get(buf, off + 12);
		return {
			startTime: UINT32_BE.get(buf, off),
			endTime: UINT32_BE.get(buf, off + 4),
			startOffset: startOffset === 4294967295 ? void 0 : startOffset,
			endOffset: endOffset === 4294967295 ? void 0 : endOffset
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v2/FrameHeader.js
/**
* Frame header length (bytes) depending on ID3v2 major version.
*/
function getFrameHeaderLength(majorVer) {
	switch (majorVer) {
		case 2: return 6;
		case 3:
		case 4: return 10;
		default: throw makeUnexpectedMajorVersionError$2(majorVer);
	}
}
function readFrameFlags(b) {
	return {
		status: {
			tag_alter_preservation: getBit(b, 0, 6),
			file_alter_preservation: getBit(b, 0, 5),
			read_only: getBit(b, 0, 4)
		},
		format: {
			grouping_identity: getBit(b, 1, 7),
			compression: getBit(b, 1, 3),
			encryption: getBit(b, 1, 2),
			unsynchronisation: getBit(b, 1, 1),
			data_length_indicator: getBit(b, 1, 0)
		}
	};
}
/**
* Factory: parse a frame header from its header bytes (6 for v2.2, 10 for v2.3/v2.4).
*
* Note: It only *parses* and does light validation. It does not read payload bytes.
*/
function readFrameHeader(uint8Array, majorVer, warningCollector) {
	switch (majorVer) {
		case 2: return parseFrameHeaderV22(uint8Array, majorVer, warningCollector);
		case 3:
		case 4: return parseFrameHeaderV23V24(uint8Array, majorVer, warningCollector);
		default: throw makeUnexpectedMajorVersionError$2(majorVer);
	}
}
function parseFrameHeaderV22(uint8Array, majorVer, warningCollector) {
	const header = {
		id: textDecode(uint8Array.subarray(0, 3), "ascii"),
		length: UINT24_BE.get(uint8Array, 3)
	};
	if (!header.id.match(/^[A-Z0-9]{3}$/)) {warningCollector.addWarning(`Invalid ID3v2.${majorVer} frame-header-ID: ${header.id}`);}
	return header;
}
function parseFrameHeaderV23V24(uint8Array, majorVer, warningCollector) {
	const header = {
		id: textDecode(uint8Array.subarray(0, 4), "ascii"),
		length: (majorVer === 4 ? UINT32SYNCSAFE : UINT32_BE).get(uint8Array, 4),
		flags: readFrameFlags(uint8Array.subarray(8, 10))
	};
	if (!header.id.match(/^[A-Z0-9]{4}$/)) {warningCollector.addWarning(`Invalid ID3v2.${majorVer} frame-header-ID: ${header.id}`);}
	return header;
}
function makeUnexpectedMajorVersionError$2(majorVer) {
	throw new Id3v2ContentError(`Unexpected majorVer: ${majorVer}`);
}
const debug = (0, (/* @__PURE__ */ __toESM(require_src(), 1)).default)("music-metadata:id3v2:frame-parser");
const defaultEnc = "latin1";
const urlEnc = {
	encoding: defaultEnc,
	bom: false
};
function parseGenre(origVal) {
	const genres = [];
	let code;
	let word = "";
	for (const c of origVal) {if (typeof code === "string") if (c === "(" && code === "") {
		word += "(";
		code = void 0;
	} else if (c === ")") {
		if (word !== "") {
			genres.push(word);
			word = "";
		}
		const genre = parseGenreCode(code);
		if (genre) genres.push(genre);
		code = void 0;
	} else code += c;
	else if (c === "(") code = "";
	else word += c;}
	if (word) {
		if (genres.length === 0 && word.match(/^\d*$/)) {word = parseGenreCode(word);}
		if (word) {genres.push(word);}
	}
	return genres;
}
function parseGenreCode(code) {
	if (code === "RX") {return "Remix";}
	if (code === "CR") {return "Cover";}
	if (code.match(/^\d*$/)) {return Genres[Number.parseInt(code, 10)];}
}
var FrameParser = class FrameParser {
	/**
	* Create id3v2 frame parser
	* @param major - Major version, e.g. (4) for  id3v2.4
	* @param warningCollector - Used to collect decode issue
	*/
	constructor(major, warningCollector) {
		this.major = major;
		this.warningCollector = warningCollector;
	}
	readData(uint8Array, type, includeCovers) {
		if (uint8Array.length === 0) {
			this.warningCollector.addWarning(`id3v2.${this.major} header has empty tag type=${type}`);
			return;
		}
		const { encoding, bom } = TextEncodingToken.get(uint8Array, 0);
		const length = uint8Array.length;
		let offset = 0;
		let output = [];
		const nullTerminatorLength = FrameParser.getNullTerminatorLength(encoding);
		let fzero;
		debug(`Parsing tag type=${type}, encoding=${encoding}, bom=${bom}`);
		switch (type !== "TXXX" && type[0] === "T" ? "T*" : type) {
			case "T*":
			case "GRP1":
			case "GP1":
			case "IPLS":
			case "MVIN":
			case "MVNM":
			case "PCS":
			case "PCST": {
				let text;
				try {
					text = FrameParser.trimNullPadding(decodeString(uint8Array.subarray(1), encoding));
				} catch (error) {
					if (error instanceof Error) {
						this.warningCollector.addWarning(`id3v2.${this.major} type=${type} header has invalid string value: ${error.message}`);
						break;
					}
					throw error;
				}
				switch (type) {
					case "TMCL":
					case "TIPL":
					case "IPLS":
						output = FrameParser.functionList(this.splitValue(type, text));
						break;
					case "TRK":
					case "TRCK":
					case "TPOS":
					case "TIT1":
					case "TIT2":
					case "TIT3":
						output = text;
						break;
					case "TCOM":
					case "TEXT":
					case "TOLY":
					case "TOPE":
					case "TPE1":
					case "TSRC":
						output = this.splitValue(type, text);
						break;
					case "TCO":
					case "TCON":
						output = this.splitValue(type, text).map((v) => parseGenre(v)).reduce((acc, val) => acc.concat(val), []);
						break;
					case "PCS":
					case "PCST":
						output = this.major >= 4 ? this.splitValue(type, text) : [text];
						output = Array.isArray(output) && output[0] === "" ? 1 : 0;
						break;
					default: output = this.major >= 4 ? this.splitValue(type, text) : [text];
				}
				break;
			}
			case "TXXX": {
				const idAndData = FrameParser.readIdentifierAndData(uint8Array.subarray(1), encoding);
				output = {
					description: idAndData.id,
					text: this.splitValue(type, decodeString(idAndData.data, encoding).replace(/\x00+$/, ""))
				};
				break;
			}
			case "PIC":
			case "APIC":
				if (includeCovers) {
					const pic = {};
					uint8Array = uint8Array.subarray(1);
					switch (this.major) {
						case 2:
							pic.format = decodeString(uint8Array.subarray(0, 3), "latin1");
							uint8Array = uint8Array.subarray(3);
							break;
						case 3:
						case 4:
							fzero = findZero(uint8Array, defaultEnc);
							pic.format = decodeString(uint8Array.subarray(0, fzero), defaultEnc);
							uint8Array = uint8Array.subarray(fzero + 1);
							break;
						default: throw makeUnexpectedMajorVersionError$1(this.major);
					}
					pic.format = FrameParser.fixPictureMimeType(pic.format);
					pic.type = AttachedPictureType[uint8Array[0]];
					uint8Array = uint8Array.subarray(1);
					fzero = findZero(uint8Array, encoding);
					pic.description = decodeString(uint8Array.subarray(0, fzero), encoding);
					uint8Array = uint8Array.subarray(fzero + nullTerminatorLength);
					pic.data = uint8Array;
					output = pic;
				}
				break;
			case "CNT":
			case "PCNT":
				output = decodeUintBE(uint8Array);
				break;
			case "SYLT": {
				const syltHeader = SyncTextHeader.get(uint8Array, 0);
				uint8Array = uint8Array.subarray(SyncTextHeader.len);
				const result = {
					descriptor: "",
					language: syltHeader.language,
					contentType: syltHeader.contentType,
					timeStampFormat: syltHeader.timeStampFormat,
					syncText: []
				};
				let readSyllables = false;
				while (uint8Array.length > 0) {
					const nullStr = FrameParser.readNullTerminatedString(uint8Array, syltHeader.encoding);
					uint8Array = uint8Array.subarray(nullStr.len);
					if (readSyllables) {
						const timestamp = UINT32_BE.get(uint8Array, 0);
						uint8Array = uint8Array.subarray(UINT32_BE.len);
						result.syncText.push({
							text: nullStr.text,
							timestamp
						});
					} else {
						result.descriptor = nullStr.text;
						readSyllables = true;
					}
				}
				output = result;
				break;
			}
			case "ULT":
			case "USLT":
			case "COM":
			case "COMM": {
				const textHeader = TextHeader.get(uint8Array, offset);
				offset += TextHeader.len;
				const descriptorStr = FrameParser.readNullTerminatedString(uint8Array.subarray(offset), textHeader.encoding);
				offset += descriptorStr.len;
				const textStr = FrameParser.readNullTerminatedString(uint8Array.subarray(offset), textHeader.encoding);
				output = {
					language: textHeader.language,
					descriptor: descriptorStr.text,
					text: textStr.text
				};
				break;
			}
			case "UFID": {
				const ufid = FrameParser.readIdentifierAndData(uint8Array, defaultEnc);
				output = {
					owner_identifier: ufid.id,
					identifier: ufid.data
				};
				break;
			}
			case "PRIV": {
				const priv = FrameParser.readIdentifierAndData(uint8Array, defaultEnc);
				output = {
					owner_identifier: priv.id,
					data: priv.data
				};
				break;
			}
			case "POPM": {
				uint8Array = uint8Array.subarray(offset);
				const emailStr = FrameParser.readNullTerminatedString(uint8Array, urlEnc);
				const email = emailStr.text;
				uint8Array = uint8Array.subarray(emailStr.len);
				if (uint8Array.length === 0) {
					this.warningCollector.addWarning(`id3v2.${this.major} type=${type} POPM frame missing rating byte`);
					output = {
						email,
						rating: 0,
						counter: void 0
					};
					break;
				}
				const rating = UINT8.get(uint8Array, 0);
				const counterBytes = uint8Array.subarray(UINT8.len);
				output = {
					email,
					rating,
					counter: counterBytes.length > 0 ? decodeUintBE(counterBytes) : void 0
				};
				break;
			}
			case "GEOB": {
				const encoding = TextEncodingToken.get(uint8Array, 0);
				uint8Array = uint8Array.subarray(1);
				const mimeTypeStr = FrameParser.readNullTerminatedString(uint8Array, urlEnc);
				const mimeType = mimeTypeStr.text;
				uint8Array = uint8Array.subarray(mimeTypeStr.len);
				const filenameStr = FrameParser.readNullTerminatedString(uint8Array, encoding);
				const filename = filenameStr.text;
				uint8Array = uint8Array.subarray(filenameStr.len);
				const descriptionStr = FrameParser.readNullTerminatedString(uint8Array, encoding);
				const description = descriptionStr.text;
				uint8Array = uint8Array.subarray(descriptionStr.len);
				output = {
					type: mimeType,
					filename,
					description,
					data: uint8Array
				};
				break;
			}
			case "WCOM":
			case "WCOP":
			case "WOAF":
			case "WOAR":
			case "WOAS":
			case "WORS":
			case "WPAY":
			case "WPUB":
				output = FrameParser.readNullTerminatedString(uint8Array, urlEnc).text;
				break;
			case "WXXX": {
				const encoding = TextEncodingToken.get(uint8Array, 0);
				uint8Array = uint8Array.subarray(1);
				const descriptionStr = FrameParser.readNullTerminatedString(uint8Array, encoding);
				const description = descriptionStr.text;
				uint8Array = uint8Array.subarray(descriptionStr.len);
				output = {
					description,
					url: FrameParser.trimNullPadding(decodeString(uint8Array, defaultEnc))
				};
				break;
			}
			case "WFD":
			case "WFED": {
				const encoding = TextEncodingToken.get(uint8Array, 0);
				uint8Array = uint8Array.subarray(1);
				output = FrameParser.readNullTerminatedString(uint8Array, encoding).text;
				break;
			}
			case "MCDI":
				output = uint8Array.subarray(0, length);
				break;
			case "CHAP": {
				debug("Reading CHAP");
				fzero = findZero(uint8Array, defaultEnc);
				const chapter = {
					label: decodeString(uint8Array.subarray(0, fzero), defaultEnc),
					info: ChapterInfo.get(uint8Array, fzero + 1),
					frames: /* @__PURE__ */ new Map()
				};
				offset += fzero + 1 + ChapterInfo.len;
				while (offset < length) {
					const subFrame = readFrameHeader(uint8Array.subarray(offset), this.major, this.warningCollector);
					const headerSize = getFrameHeaderLength(this.major);
					offset += headerSize;
					const subOutput = this.readData(uint8Array.subarray(offset, offset + subFrame.length), subFrame.id, includeCovers);
					offset += subFrame.length;
					chapter.frames.set(subFrame.id, subOutput);
				}
				output = chapter;
				break;
			}
			case "CTOC": {
				debug("Reading CTOC");
				const idEnd = findZero(uint8Array, defaultEnc);
				const label = decodeString(uint8Array.subarray(0, idEnd), defaultEnc);
				offset = idEnd + 1;
				const flags = uint8Array[offset++];
				const topLevel = (flags & 2) !== 0;
				const ordered = (flags & 1) !== 0;
				const entryCount = uint8Array[offset++];
				const childElementIds = [];
				for (let i = 0; i < entryCount && offset < length; i++) {
					const end = findZero(uint8Array.subarray(offset), defaultEnc);
					const childId = decodeString(uint8Array.subarray(offset, offset + end), defaultEnc);
					childElementIds.push(childId);
					offset += end + 1;
				}
				const toc = {
					label,
					flags: {
						topLevel,
						ordered
					},
					childElementIds,
					frames: /* @__PURE__ */ new Map()
				};
				while (offset < length) {
					const subFrame = readFrameHeader(uint8Array.subarray(offset), this.major, this.warningCollector);
					const headerSize = getFrameHeaderLength(this.major);
					offset += headerSize;
					const subOutput = this.readData(uint8Array.subarray(offset, offset + subFrame.length), subFrame.id, includeCovers);
					offset += subFrame.length;
					toc.frames.set(subFrame.id, subOutput);
				}
				output = toc;
				break;
			}
			default:
				debug(`Warning: unsupported id3v2-tag-type: ${type}`);
				break;
		}
		return output;
	}
	static readNullTerminatedString(uint8Array, encoding) {
		const bomSize = encoding.bom ? 2 : 0;
		const originalLen = uint8Array.length;
		const valueArray = uint8Array.subarray(bomSize);
		const zeroIndex = findZero(valueArray, encoding.encoding);
		if (zeroIndex >= valueArray.length) {return {
			text: decodeString(valueArray, encoding.encoding),
			len: originalLen
		};}
		return {
			text: decodeString(valueArray.subarray(0, zeroIndex), encoding.encoding),
			len: bomSize + zeroIndex + FrameParser.getNullTerminatorLength(encoding.encoding)
		};
	}
	static fixPictureMimeType(pictureType) {
		pictureType = pictureType.toLocaleLowerCase();
		switch (pictureType) {
			case "jpg": return "image/jpeg";
			case "png": return "image/png";
		}
		return pictureType;
	}
	/**
	* Converts TMCL (Musician credits list) or TIPL (Involved people list)
	* @param entries
	*/
	static functionList(entries) {
		const res = {};
		for (let i = 0; i + 1 < entries.length; i += 2) {
			const names = entries[i + 1].split(",");
			res[entries[i]] = res[entries[i]] ? res[entries[i]].concat(names) : names;
		}
		return res;
	}
	/**
	* id3v2.4 defines that multiple T* values are separated by 0x00
	* id3v2.3 defines that TCOM, TEXT, TOLY, TOPE & TPE1 values are separated by /
	* @param tag - Tag name
	* @param text - Concatenated tag value
	* @returns Split tag value
	*/
	splitValue(tag, text) {
		let values;
		if (this.major < 4) {
			values = text.split(/\x00/g);
			if (values.length > 1) {this.warningCollector.addWarning(`ID3v2.${this.major} ${tag} uses non standard null-separator.`);}
			else {values = text.split(/\//g);}
		} else {values = text.split(/\x00/g);}
		return FrameParser.trimArray(values);
	}
	static trimArray(values) {
		return values.map((value) => FrameParser.trimNullPadding(value).trim());
	}
	static trimNullPadding(value) {
		let end = value.length;
		while (end > 0 && value.charCodeAt(end - 1) === 0) {end--;}
		return end === value.length ? value : value.slice(0, end);
	}
	static readIdentifierAndData(uint8Array, encoding) {
		const idStr = FrameParser.readNullTerminatedString(uint8Array, {
			encoding,
			bom: false
		});
		return {
			id: idStr.text,
			data: uint8Array.subarray(idStr.len)
		};
	}
	static getNullTerminatorLength(enc) {
		return enc.startsWith("utf-16") ? 2 : 1;
	}
};
var Id3v2ContentError = class extends makeUnexpectedFileContentError("id3v2") {};
function makeUnexpectedMajorVersionError$1(majorVer) {
	throw new Id3v2ContentError(`Unexpected majorVer: ${majorVer}`);
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v2/ID3v2Parser.js
var ID3v2Parser = class ID3v2Parser {
	constructor() {
		this.tokenizer = void 0;
		this.id3Header = void 0;
		this.metadata = void 0;
		this.headerType = void 0;
		this.options = void 0;
	}
	static removeUnsyncBytes(buffer) {
		let readI = 0;
		let writeI = 0;
		while (readI < buffer.length - 1) {
			if (readI !== writeI) {buffer[writeI] = buffer[readI];}
			readI += buffer[readI] === 255 && buffer[readI + 1] === 0 ? 2 : 1;
			writeI++;
		}
		if (readI < buffer.length) {buffer[writeI++] = buffer[readI];}
		return buffer.subarray(0, writeI);
	}
	static readFrameData(uint8Array, frameHeader, majorVer, includeCovers, warningCollector) {
		const frameParser = new FrameParser(majorVer, warningCollector);
		switch (majorVer) {
			case 2: return frameParser.readData(uint8Array, frameHeader.id, includeCovers);
			case 3:
			case 4:
				if (frameHeader.flags?.format.unsynchronisation) {uint8Array = ID3v2Parser.removeUnsyncBytes(uint8Array);}
				if (frameHeader.flags?.format.data_length_indicator) {uint8Array = uint8Array.subarray(4, uint8Array.length);}
				return frameParser.readData(uint8Array, frameHeader.id, includeCovers);
			default: throw makeUnexpectedMajorVersionError(majorVer);
		}
	}
	/**
	* Create a combined tag key, of tag & description
	* @param tag e.g.: COM
	* @param description e.g. iTunPGAP
	* @returns string e.g. COM:iTunPGAP
	*/
	static makeDescriptionTagName(tag, description) {
		return tag + (description ? `:${description}` : "");
	}
	async parse(metadata, tokenizer, options) {
		this.tokenizer = tokenizer;
		this.metadata = metadata;
		this.options = options;
		const id3Header = await this.tokenizer.readToken(ID3v2Header);
		if (id3Header.fileIdentifier !== "ID3") {throw new Id3v2ContentError("expected ID3-header file-identifier 'ID3' was not found");}
		this.id3Header = id3Header;
		this.headerType = `ID3v2.${id3Header.version.major}`;
		await (id3Header.flags.isExtendedHeader ? this.parseExtendedHeader() : this.parseId3Data(id3Header.size));
		const chapters = ID3v2Parser.mapId3v2Chapters(this.metadata.native[this.headerType]);
		this.metadata.setFormat("chapters", chapters);
	}
	async parseExtendedHeader() {
		const extendedHeader = await this.tokenizer.readToken(ExtendedHeader);
		const dataRemaining = extendedHeader.size - ExtendedHeader.len;
		return dataRemaining > 0 ? this.parseExtendedHeaderData(dataRemaining, extendedHeader.size) : this.parseId3Data(this.id3Header.size - extendedHeader.size);
	}
	async parseExtendedHeaderData(dataRemaining, extendedHeaderSize) {
		await this.tokenizer.ignore(dataRemaining);
		return this.parseId3Data(this.id3Header.size - extendedHeaderSize);
	}
	async parseId3Data(dataLen) {
		const uint8Array = await this.tokenizer.readToken(new Uint8ArrayType(dataLen));
		for (const tag of this.parseMetadata(uint8Array)) {switch (tag.id) {
			case "TXXX":
				if (tag.value) await this.handleTag(tag, tag.value.text, () => tag.value.description);
				break;
			default: await (Array.isArray(tag.value) ? Promise.all(tag.value.map((value) => this.addTag(tag.id, value))) : this.addTag(tag.id, tag.value));
		}}
	}
	async handleTag(tag, values, descriptor, resolveValue = (value) => value) {
		await Promise.all(values.map((value) => this.addTag(ID3v2Parser.makeDescriptionTagName(tag.id, descriptor(value)), resolveValue(value))));
	}
	async addTag(id, value) {
		await this.metadata.addTag(this.headerType, id, value);
	}
	parseMetadata(data) {
		let offset = 0;
		const tags = [];
		while (true) {
			if (offset === data.length) {break;}
			const frameHeaderLength = getFrameHeaderLength(this.id3Header.version.major);
			if (offset + frameHeaderLength > data.length) {
				this.metadata.addWarning("Illegal ID3v2 tag length");
				break;
			}
			const frameHeaderBytes = data.subarray(offset, offset + frameHeaderLength);
			offset += frameHeaderLength;
			const frameHeader = readFrameHeader(frameHeaderBytes, this.id3Header.version.major, this.metadata);
			const frameDataBytes = data.subarray(offset, offset + frameHeader.length);
			offset += frameHeader.length;
			const values = ID3v2Parser.readFrameData(frameDataBytes, frameHeader, this.id3Header.version.major, !this.options.skipCovers, this.metadata);
			if (values) {tags.push({
				id: frameHeader.id,
				value: values
			});}
		}
		return tags;
	}
	/**
	* Convert parsed ID3v2 chapter frames (CHAP / CTOC) to generic `format.chapters`.
	*
	* This function expects the `native` tags already to contain parsed `CHAP` and `CTOC` frame values,
	* as produced by `FrameParser.readData`.
	*/
	static mapId3v2Chapters(id3Tags) {
		if (!id3Tags) {return;}
		const chapFrames = id3Tags.filter((t) => t.id === "CHAP");
		if (!chapFrames?.length) {return;}
		const topLevelToc = id3Tags.filter((t) => t.id === "CTOC")?.find((t) => t.value.flags?.topLevel);
		const chapterById = /* @__PURE__ */ new Map();
		for (const chap of chapFrames) {chapterById.set(chap.value.label, chap.value);}
		const orderedIds = topLevelToc?.value.childElementIds;
		const chapters = [];
		const source = orderedIds ?? [...chapterById.keys()];
		for (const id of source) {
			const chap = chapterById.get(id);
			if (!chap) {continue;}
			const frames = chap.frames;
			const title = frames.get("TIT2");
			if (!title) {continue;}
			chapters.push({
				id,
				title,
				url: frames.get("WXXX"),
				start: chap.info.startTime / 1e3,
				end: chap.info.endTime / 1e3,
				image: frames.get("APIC")
			});
		}
		if (!orderedIds) {chapters.sort((a, b) => a.start - b.start);}
		return chapters.length ? chapters : void 0;
	}
};
function makeUnexpectedMajorVersionError(majorVer) {
	throw new Id3v2ContentError(`Unexpected majorVer: ${majorVer}`);
}
//#endregion
export { ID3v2Parser as t };
