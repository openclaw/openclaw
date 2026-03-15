import { o as __toESM, t as __commonJSMin } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, a as UnsupportedFileTypeError, i as InternalParserError, k as textDecode, n as CouldNotDetermineFileTypeError } from "./BasicParser-CJDqseT1.js";
import { t as fromBuffer } from "./lib-BPhRo--R.js";
import { l as toRatio, n as decodeString } from "./Util-C3ovgFZT.js";
import { c as TimestampFormat, i as LyricsContentType } from "./ID3v2Token-BPbBfqkQ.js";
import { t as APEv2Parser } from "./APEv2Parser-C7cXS6nR.js";
import { r as hasID3v1Header } from "./ID3v1Parser-BdpkOjEn.js";
import { n as TrackType, r as TrackTypeValueToKeyMap } from "./types-BYhULvsH.js";
import { fileTypeFromBuffer } from "file-type";
//#region node_modules/.pnpm/content-type@1.0.5/node_modules/content-type/index.js
/*!
* content-type
* Copyright(c) 2015 Douglas Christopher Wilson
* MIT Licensed
*/
var require_content_type = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* RegExp to match *( ";" parameter ) in RFC 7231 sec 3.1.1.1
	*
	* parameter     = token "=" ( token / quoted-string )
	* token         = 1*tchar
	* tchar         = "!" / "#" / "$" / "%" / "&" / "'" / "*"
	*               / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
	*               / DIGIT / ALPHA
	*               ; any VCHAR, except delimiters
	* quoted-string = DQUOTE *( qdtext / quoted-pair ) DQUOTE
	* qdtext        = HTAB / SP / %x21 / %x23-5B / %x5D-7E / obs-text
	* obs-text      = %x80-FF
	* quoted-pair   = "\" ( HTAB / SP / VCHAR / obs-text )
	*/
	var PARAM_REGEXP = /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
	/**
	* RegExp to match quoted-pair in RFC 7230 sec 3.2.6
	*
	* quoted-pair = "\" ( HTAB / SP / VCHAR / obs-text )
	* obs-text    = %x80-FF
	*/
	var QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g;
	/**
	* RegExp to match type in RFC 7231 sec 3.1.1.1
	*
	* media-type = type "/" subtype
	* type       = token
	* subtype    = token
	*/
	var TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
	exports.parse = parse;
	/**
	* Parse media type to object.
	*
	* @param {string|object} string
	* @return {Object}
	* @public
	*/
	function parse(string) {
		if (!string) {throw new TypeError("argument string is required");}
		var header = typeof string === "object" ? getcontenttype(string) : string;
		if (typeof header !== "string") {throw new TypeError("argument string is required to be a string");}
		var index = header.indexOf(";");
		var type = index !== -1 ? header.slice(0, index).trim() : header.trim();
		if (!TYPE_REGEXP.test(type)) {throw new TypeError("invalid media type");}
		var obj = new ContentType(type.toLowerCase());
		if (index !== -1) {
			var key;
			var match;
			var value;
			PARAM_REGEXP.lastIndex = index;
			while (match = PARAM_REGEXP.exec(header)) {
				if (match.index !== index) {throw new TypeError("invalid parameter format");}
				index += match[0].length;
				key = match[1].toLowerCase();
				value = match[2];
				if (value.charCodeAt(0) === 34) {
					value = value.slice(1, -1);
					if (value.indexOf("\\") !== -1) {value = value.replace(QESC_REGEXP, "$1");}
				}
				obj.parameters[key] = value;
			}
			if (index !== header.length) {throw new TypeError("invalid parameter format");}
		}
		return obj;
	}
	/**
	* Get content-type from req/res objects.
	*
	* @param {object}
	* @return {Object}
	* @private
	*/
	function getcontenttype(obj) {
		var header;
		if (typeof obj.getHeader === "function") {header = obj.getHeader("content-type");}
		else if (typeof obj.headers === "object") {header = obj.headers && obj.headers["content-type"];}
		if (typeof header !== "string") {throw new TypeError("content-type header is missing from object");}
		return header;
	}
	/**
	* Class to represent a content type.
	* @private
	*/
	function ContentType(type) {
		this.parameters = Object.create(null);
		this.type = type;
	}
}));
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/common/GenericTagTypes.js
var import_media_typer = (/* @__PURE__ */ __commonJSMin(((exports) => {
	var TYPE_REGEXP = /^ *([A-Za-z0-9][A-Za-z0-9!#$&^_-]{0,126})\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}) *$/;
	exports.parse = parse;
	/**
	* Parse media type to object.
	*
	* @param {string} string
	* @return {object}
	* @public
	*/
	function parse(string) {
		if (!string) {throw new TypeError("argument string is required");}
		if (typeof string !== "string") {throw new TypeError("argument string is required to be a string");}
		var match = TYPE_REGEXP.exec(string.toLowerCase());
		if (!match) {throw new TypeError("invalid media type");}
		var type = match[1];
		var subtype = match[2];
		var suffix;
		var index = subtype.lastIndexOf("+");
		if (index !== -1) {
			suffix = subtype.substr(index + 1);
			subtype = subtype.substr(0, index);
		}
		return new MediaType(type, subtype, suffix);
	}
	/**
	* Class for MediaType object.
	* @public
	*/
	function MediaType(type, subtype, suffix) {
		this.type = type;
		this.subtype = subtype;
		this.suffix = suffix;
	}
})))();
var import_content_type = /* @__PURE__ */ __toESM(require_content_type(), 1);
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
const defaultTagInfo = { multiple: false };
const commonTags = {
	year: defaultTagInfo,
	track: defaultTagInfo,
	disk: defaultTagInfo,
	title: defaultTagInfo,
	artist: defaultTagInfo,
	artists: {
		multiple: true,
		unique: true
	},
	albumartist: defaultTagInfo,
	albumartists: {
		multiple: true,
		unique: true
	},
	album: defaultTagInfo,
	date: defaultTagInfo,
	originaldate: defaultTagInfo,
	originalyear: defaultTagInfo,
	releasedate: defaultTagInfo,
	comment: {
		multiple: true,
		unique: false
	},
	genre: {
		multiple: true,
		unique: true
	},
	picture: {
		multiple: true,
		unique: true
	},
	composer: {
		multiple: true,
		unique: true
	},
	lyrics: {
		multiple: true,
		unique: false
	},
	albumsort: {
		multiple: false,
		unique: true
	},
	titlesort: {
		multiple: false,
		unique: true
	},
	work: {
		multiple: false,
		unique: true
	},
	artistsort: {
		multiple: false,
		unique: true
	},
	albumartistsort: {
		multiple: false,
		unique: true
	},
	composersort: {
		multiple: false,
		unique: true
	},
	lyricist: {
		multiple: true,
		unique: true
	},
	writer: {
		multiple: true,
		unique: true
	},
	conductor: {
		multiple: true,
		unique: true
	},
	remixer: {
		multiple: true,
		unique: true
	},
	arranger: {
		multiple: true,
		unique: true
	},
	engineer: {
		multiple: true,
		unique: true
	},
	producer: {
		multiple: true,
		unique: true
	},
	technician: {
		multiple: true,
		unique: true
	},
	djmixer: {
		multiple: true,
		unique: true
	},
	mixer: {
		multiple: true,
		unique: true
	},
	label: {
		multiple: true,
		unique: true
	},
	grouping: defaultTagInfo,
	subtitle: { multiple: true },
	discsubtitle: defaultTagInfo,
	totaltracks: defaultTagInfo,
	totaldiscs: defaultTagInfo,
	compilation: defaultTagInfo,
	rating: { multiple: true },
	bpm: defaultTagInfo,
	mood: defaultTagInfo,
	media: defaultTagInfo,
	catalognumber: {
		multiple: true,
		unique: true
	},
	tvShow: defaultTagInfo,
	tvShowSort: defaultTagInfo,
	tvSeason: defaultTagInfo,
	tvEpisode: defaultTagInfo,
	tvEpisodeId: defaultTagInfo,
	tvNetwork: defaultTagInfo,
	podcast: defaultTagInfo,
	podcasturl: defaultTagInfo,
	releasestatus: defaultTagInfo,
	releasetype: { multiple: true },
	releasecountry: defaultTagInfo,
	script: defaultTagInfo,
	language: defaultTagInfo,
	copyright: defaultTagInfo,
	license: defaultTagInfo,
	encodedby: defaultTagInfo,
	encodersettings: defaultTagInfo,
	gapless: defaultTagInfo,
	barcode: defaultTagInfo,
	isrc: { multiple: true },
	asin: defaultTagInfo,
	musicbrainz_recordingid: defaultTagInfo,
	musicbrainz_trackid: defaultTagInfo,
	musicbrainz_albumid: defaultTagInfo,
	musicbrainz_artistid: { multiple: true },
	musicbrainz_albumartistid: { multiple: true },
	musicbrainz_releasegroupid: defaultTagInfo,
	musicbrainz_workid: defaultTagInfo,
	musicbrainz_trmid: defaultTagInfo,
	musicbrainz_discid: defaultTagInfo,
	acoustid_id: defaultTagInfo,
	acoustid_fingerprint: defaultTagInfo,
	musicip_puid: defaultTagInfo,
	musicip_fingerprint: defaultTagInfo,
	website: defaultTagInfo,
	"performer:instrument": {
		multiple: true,
		unique: true
	},
	averageLevel: defaultTagInfo,
	peakLevel: defaultTagInfo,
	notes: {
		multiple: true,
		unique: false
	},
	key: defaultTagInfo,
	originalalbum: defaultTagInfo,
	originalartist: defaultTagInfo,
	discogs_artist_id: {
		multiple: true,
		unique: true
	},
	discogs_release_id: defaultTagInfo,
	discogs_label_id: defaultTagInfo,
	discogs_master_release_id: defaultTagInfo,
	discogs_votes: defaultTagInfo,
	discogs_rating: defaultTagInfo,
	replaygain_track_peak: defaultTagInfo,
	replaygain_track_gain: defaultTagInfo,
	replaygain_album_peak: defaultTagInfo,
	replaygain_album_gain: defaultTagInfo,
	replaygain_track_minmax: defaultTagInfo,
	replaygain_album_minmax: defaultTagInfo,
	replaygain_undo: defaultTagInfo,
	description: { multiple: true },
	longDescription: defaultTagInfo,
	category: { multiple: true },
	hdVideo: defaultTagInfo,
	keywords: { multiple: true },
	movement: defaultTagInfo,
	movementIndex: defaultTagInfo,
	movementTotal: defaultTagInfo,
	podcastId: defaultTagInfo,
	showMovement: defaultTagInfo,
	stik: defaultTagInfo,
	playCounter: defaultTagInfo
};
/**
* @param alias Name of common tag
* @returns {boolean|*} true if given alias is mapped as a singleton', otherwise false
*/
function isSingleton(alias) {
	return commonTags[alias] && !commonTags[alias].multiple;
}
/**
* @param alias Common (generic) tag
* @returns {boolean|*} true if given alias is a singleton or explicitly marked as unique
*/
function isUnique(alias) {
	return !commonTags[alias].multiple || commonTags[alias].unique || false;
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/common/GenericTagMapper.js
var CommonTagMapper = class {
	static toIntOrNull(str) {
		const cleaned = Number.parseInt(str, 10);
		return Number.isNaN(cleaned) ? null : cleaned;
	}
	static normalizeTrack(origVal) {
		const split = origVal.toString().split("/");
		return {
			no: Number.parseInt(split[0], 10) || null,
			of: Number.parseInt(split[1], 10) || null
		};
	}
	constructor(tagTypes, tagMap) {
		this.tagTypes = tagTypes;
		this.tagMap = tagMap;
	}
	/**
	* Process and set common tags
	* write common tags to
	* @param tag Native tag
	* @param warnings Register warnings
	* @return common name
	*/
	mapGenericTag(tag, warnings) {
		tag = {
			id: tag.id,
			value: tag.value
		};
		this.postMap(tag, warnings);
		const id = this.getCommonName(tag.id);
		return id ? {
			id,
			value: tag.value
		} : null;
	}
	/**
	* Convert native tag key to common tag key
	* @param tag Native header tag
	* @return common tag name (alias)
	*/
	getCommonName(tag) {
		return this.tagMap[tag];
	}
	/**
	* Handle post mapping exceptions / correction
	* @param tag Tag e.g. {"©alb", "Buena Vista Social Club")
	* @param warnings Used to register warnings
	*/
	postMap(_tag, _warnings) {}
};
CommonTagMapper.maxRatingScore = 1;
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v1/ID3v1TagMap.js
/**
* ID3v1 tag mappings
*/
const id3v1TagMap = {
	title: "title",
	artist: "artist",
	album: "album",
	year: "year",
	comment: "comment",
	track: "track",
	genre: "genre"
};
var ID3v1TagMapper = class extends CommonTagMapper {
	constructor() {
		super(["ID3v1"], id3v1TagMap);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/common/CaseInsensitiveTagMap.js
var CaseInsensitiveTagMap = class extends CommonTagMapper {
	constructor(tagTypes, tagMap) {
		const upperCaseMap = {};
		for (const tag of Object.keys(tagMap)) {upperCaseMap[tag.toUpperCase()] = tagMap[tag];}
		super(tagTypes, upperCaseMap);
	}
	/**
	* @tag  Native header tag
	* @return common tag name (alias)
	*/
	getCommonName(tag) {
		return this.tagMap[tag.toUpperCase()];
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v2/ID3v24TagMapper.js
/**
* ID3v2.3/ID3v2.4 tag mappings
*/
const id3v24TagMap = {
	TIT2: "title",
	TPE1: "artist",
	"TXXX:Artists": "artists",
	TPE2: "albumartist",
	TALB: "album",
	TDRV: "date",
	TORY: "originalyear",
	TPOS: "disk",
	TCON: "genre",
	APIC: "picture",
	TCOM: "composer",
	USLT: "lyrics",
	TSOA: "albumsort",
	TSOT: "titlesort",
	TOAL: "originalalbum",
	TSOP: "artistsort",
	TSO2: "albumartistsort",
	TSOC: "composersort",
	TEXT: "lyricist",
	"TXXX:Writer": "writer",
	TPE3: "conductor",
	TPE4: "remixer",
	"IPLS:arranger": "arranger",
	"IPLS:engineer": "engineer",
	"IPLS:producer": "producer",
	"IPLS:DJ-mix": "djmixer",
	"IPLS:mix": "mixer",
	TPUB: "label",
	TIT1: "grouping",
	TIT3: "subtitle",
	TRCK: "track",
	TCMP: "compilation",
	POPM: "rating",
	TBPM: "bpm",
	TMED: "media",
	"TXXX:CATALOGNUMBER": "catalognumber",
	"TXXX:MusicBrainz Album Status": "releasestatus",
	"TXXX:MusicBrainz Album Type": "releasetype",
	"TXXX:MusicBrainz Album Release Country": "releasecountry",
	"TXXX:RELEASECOUNTRY": "releasecountry",
	"TXXX:SCRIPT": "script",
	TLAN: "language",
	TCOP: "copyright",
	WCOP: "license",
	TENC: "encodedby",
	TSSE: "encodersettings",
	"TXXX:BARCODE": "barcode",
	"TXXX:ISRC": "isrc",
	TSRC: "isrc",
	"TXXX:ASIN": "asin",
	"TXXX:originalyear": "originalyear",
	"UFID:http://musicbrainz.org": "musicbrainz_recordingid",
	"TXXX:MusicBrainz Release Track Id": "musicbrainz_trackid",
	"TXXX:MusicBrainz Album Id": "musicbrainz_albumid",
	"TXXX:MusicBrainz Artist Id": "musicbrainz_artistid",
	"TXXX:MusicBrainz Album Artist Id": "musicbrainz_albumartistid",
	"TXXX:MusicBrainz Release Group Id": "musicbrainz_releasegroupid",
	"TXXX:MusicBrainz Work Id": "musicbrainz_workid",
	"TXXX:MusicBrainz TRM Id": "musicbrainz_trmid",
	"TXXX:MusicBrainz Disc Id": "musicbrainz_discid",
	"TXXX:ACOUSTID_ID": "acoustid_id",
	"TXXX:Acoustid Id": "acoustid_id",
	"TXXX:Acoustid Fingerprint": "acoustid_fingerprint",
	"TXXX:MusicIP PUID": "musicip_puid",
	"TXXX:MusicMagic Fingerprint": "musicip_fingerprint",
	WOAR: "website",
	TDRC: "date",
	TYER: "year",
	TDOR: "originaldate",
	"TIPL:arranger": "arranger",
	"TIPL:engineer": "engineer",
	"TIPL:producer": "producer",
	"TIPL:DJ-mix": "djmixer",
	"TIPL:mix": "mixer",
	TMOO: "mood",
	SYLT: "lyrics",
	TSST: "discsubtitle",
	TKEY: "key",
	COMM: "comment",
	TOPE: "originalartist",
	"PRIV:AverageLevel": "averageLevel",
	"PRIV:PeakLevel": "peakLevel",
	"TXXX:DISCOGS_ARTIST_ID": "discogs_artist_id",
	"TXXX:DISCOGS_ARTISTS": "artists",
	"TXXX:DISCOGS_ARTIST_NAME": "artists",
	"TXXX:DISCOGS_ALBUM_ARTISTS": "albumartist",
	"TXXX:DISCOGS_CATALOG": "catalognumber",
	"TXXX:DISCOGS_COUNTRY": "releasecountry",
	"TXXX:DISCOGS_DATE": "originaldate",
	"TXXX:DISCOGS_LABEL": "label",
	"TXXX:DISCOGS_LABEL_ID": "discogs_label_id",
	"TXXX:DISCOGS_MASTER_RELEASE_ID": "discogs_master_release_id",
	"TXXX:DISCOGS_RATING": "discogs_rating",
	"TXXX:DISCOGS_RELEASED": "date",
	"TXXX:DISCOGS_RELEASE_ID": "discogs_release_id",
	"TXXX:DISCOGS_VOTES": "discogs_votes",
	"TXXX:CATALOGID": "catalognumber",
	"TXXX:STYLE": "genre",
	"TXXX:REPLAYGAIN_TRACK_PEAK": "replaygain_track_peak",
	"TXXX:REPLAYGAIN_TRACK_GAIN": "replaygain_track_gain",
	"TXXX:REPLAYGAIN_ALBUM_PEAK": "replaygain_album_peak",
	"TXXX:REPLAYGAIN_ALBUM_GAIN": "replaygain_album_gain",
	"TXXX:MP3GAIN_MINMAX": "replaygain_track_minmax",
	"TXXX:MP3GAIN_ALBUM_MINMAX": "replaygain_album_minmax",
	"TXXX:MP3GAIN_UNDO": "replaygain_undo",
	MVNM: "movement",
	MVIN: "movementIndex",
	PCST: "podcast",
	TCAT: "category",
	TDES: "description",
	TDRL: "releasedate",
	TGID: "podcastId",
	TKWD: "keywords",
	WFED: "podcasturl",
	GRP1: "grouping",
	PCNT: "playCounter"
};
var ID3v24TagMapper = class ID3v24TagMapper extends CaseInsensitiveTagMap {
	static toRating(popm) {
		return {
			source: popm.email,
			rating: popm.rating > 0 ? (popm.rating - 1) / 254 * CommonTagMapper.maxRatingScore : void 0
		};
	}
	constructor() {
		super(["ID3v2.3", "ID3v2.4"], id3v24TagMap);
	}
	/**
	* Handle post mapping exceptions / correction
	* @param tag to post map
	* @param warnings Wil be used to register (collect) warnings
	*/
	postMap(tag, warnings) {
		switch (tag.id) {
			case "UFID":
				{
					const idTag = tag.value;
					if (idTag.owner_identifier === "http://musicbrainz.org") {
						tag.id += `:${idTag.owner_identifier}`;
						tag.value = decodeString(idTag.identifier, "latin1");
					}
				}
				break;
			case "PRIV":
				{
					const customTag = tag.value;
					switch (customTag.owner_identifier) {
						case "AverageLevel":
						case "PeakValue":
							tag.id += `:${customTag.owner_identifier}`;
							tag.value = customTag.data.length === 4 ? UINT32_LE.get(customTag.data, 0) : null;
							if (tag.value === null) {warnings.addWarning("Failed to parse PRIV:PeakValue");}
							break;
						default: warnings.addWarning(`Unknown PRIV owner-identifier: ${customTag.data}`);
					}
				}
				break;
			case "POPM":
				tag.value = ID3v24TagMapper.toRating(tag.value);
				break;
			default: break;
		}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/asf/AsfTagMapper.js
/**
* ASF Metadata tag mappings.
* See http://msdn.microsoft.com/en-us/library/ms867702.aspx
*/
const asfTagMap = {
	Title: "title",
	Author: "artist",
	"WM/AlbumArtist": "albumartist",
	"WM/AlbumTitle": "album",
	"WM/Year": "date",
	"WM/OriginalReleaseTime": "originaldate",
	"WM/OriginalReleaseYear": "originalyear",
	Description: "comment",
	"WM/TrackNumber": "track",
	"WM/PartOfSet": "disk",
	"WM/Genre": "genre",
	"WM/Composer": "composer",
	"WM/Lyrics": "lyrics",
	"WM/AlbumSortOrder": "albumsort",
	"WM/TitleSortOrder": "titlesort",
	"WM/ArtistSortOrder": "artistsort",
	"WM/AlbumArtistSortOrder": "albumartistsort",
	"WM/ComposerSortOrder": "composersort",
	"WM/Writer": "lyricist",
	"WM/Conductor": "conductor",
	"WM/ModifiedBy": "remixer",
	"WM/Engineer": "engineer",
	"WM/Producer": "producer",
	"WM/DJMixer": "djmixer",
	"WM/Mixer": "mixer",
	"WM/Publisher": "label",
	"WM/ContentGroupDescription": "grouping",
	"WM/SubTitle": "subtitle",
	"WM/SetSubTitle": "discsubtitle",
	"WM/IsCompilation": "compilation",
	"WM/SharedUserRating": "rating",
	"WM/BeatsPerMinute": "bpm",
	"WM/Mood": "mood",
	"WM/Media": "media",
	"WM/CatalogNo": "catalognumber",
	"MusicBrainz/Album Status": "releasestatus",
	"MusicBrainz/Album Type": "releasetype",
	"MusicBrainz/Album Release Country": "releasecountry",
	"WM/Script": "script",
	"WM/Language": "language",
	Copyright: "copyright",
	LICENSE: "license",
	"WM/EncodedBy": "encodedby",
	"WM/EncodingSettings": "encodersettings",
	"WM/Barcode": "barcode",
	"WM/ISRC": "isrc",
	"MusicBrainz/Track Id": "musicbrainz_recordingid",
	"MusicBrainz/Release Track Id": "musicbrainz_trackid",
	"MusicBrainz/Album Id": "musicbrainz_albumid",
	"MusicBrainz/Artist Id": "musicbrainz_artistid",
	"MusicBrainz/Album Artist Id": "musicbrainz_albumartistid",
	"MusicBrainz/Release Group Id": "musicbrainz_releasegroupid",
	"MusicBrainz/Work Id": "musicbrainz_workid",
	"MusicBrainz/TRM Id": "musicbrainz_trmid",
	"MusicBrainz/Disc Id": "musicbrainz_discid",
	"Acoustid/Id": "acoustid_id",
	"Acoustid/Fingerprint": "acoustid_fingerprint",
	"MusicIP/PUID": "musicip_puid",
	"WM/ARTISTS": "artists",
	"WM/InitialKey": "key",
	ASIN: "asin",
	"WM/Work": "work",
	"WM/AuthorURL": "website",
	"WM/Picture": "picture"
};
var AsfTagMapper = class AsfTagMapper extends CommonTagMapper {
	static toRating(rating) {
		return { rating: Number.parseFloat(rating + 1) / 5 };
	}
	constructor() {
		super(["asf"], asfTagMap);
	}
	postMap(tag) {
		switch (tag.id) {
			case "WM/SharedUserRating": {
				const keys = tag.id.split(":");
				tag.value = AsfTagMapper.toRating(tag.value);
				tag.id = keys[0];
				break;
			}
		}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v2/ID3v22TagMapper.js
/**
* ID3v2.2 tag mappings
*/
const id3v22TagMap = {
	TT2: "title",
	TP1: "artist",
	TP2: "albumartist",
	TAL: "album",
	TYE: "year",
	COM: "comment",
	TRK: "track",
	TPA: "disk",
	TCO: "genre",
	PIC: "picture",
	TCM: "composer",
	TOR: "originaldate",
	TOT: "originalalbum",
	TXT: "lyricist",
	TP3: "conductor",
	TPB: "label",
	TT1: "grouping",
	TT3: "subtitle",
	TLA: "language",
	TCR: "copyright",
	WCP: "license",
	TEN: "encodedby",
	TSS: "encodersettings",
	WAR: "website",
	PCS: "podcast",
	TCP: "compilation",
	TDR: "date",
	TS2: "albumartistsort",
	TSA: "albumsort",
	TSC: "composersort",
	TSP: "artistsort",
	TST: "titlesort",
	WFD: "podcasturl",
	TBP: "bpm",
	GP1: "grouping"
};
var ID3v22TagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super(["ID3v2.2"], id3v22TagMap);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/apev2/APEv2TagMapper.js
/**
* ID3v2.2 tag mappings
*/
const apev2TagMap = {
	Title: "title",
	Artist: "artist",
	Artists: "artists",
	"Album Artist": "albumartist",
	Album: "album",
	Year: "date",
	Originalyear: "originalyear",
	Originaldate: "originaldate",
	Releasedate: "releasedate",
	Comment: "comment",
	Track: "track",
	Disc: "disk",
	DISCNUMBER: "disk",
	Genre: "genre",
	"Cover Art (Front)": "picture",
	"Cover Art (Back)": "picture",
	Composer: "composer",
	Lyrics: "lyrics",
	ALBUMSORT: "albumsort",
	TITLESORT: "titlesort",
	WORK: "work",
	ARTISTSORT: "artistsort",
	ALBUMARTISTSORT: "albumartistsort",
	COMPOSERSORT: "composersort",
	Lyricist: "lyricist",
	Writer: "writer",
	Conductor: "conductor",
	MixArtist: "remixer",
	Arranger: "arranger",
	Engineer: "engineer",
	Producer: "producer",
	DJMixer: "djmixer",
	Mixer: "mixer",
	Label: "label",
	Grouping: "grouping",
	Subtitle: "subtitle",
	DiscSubtitle: "discsubtitle",
	Compilation: "compilation",
	BPM: "bpm",
	Mood: "mood",
	Media: "media",
	CatalogNumber: "catalognumber",
	MUSICBRAINZ_ALBUMSTATUS: "releasestatus",
	MUSICBRAINZ_ALBUMTYPE: "releasetype",
	RELEASECOUNTRY: "releasecountry",
	Script: "script",
	Language: "language",
	Copyright: "copyright",
	LICENSE: "license",
	EncodedBy: "encodedby",
	EncoderSettings: "encodersettings",
	Barcode: "barcode",
	ISRC: "isrc",
	ASIN: "asin",
	musicbrainz_trackid: "musicbrainz_recordingid",
	musicbrainz_releasetrackid: "musicbrainz_trackid",
	MUSICBRAINZ_ALBUMID: "musicbrainz_albumid",
	MUSICBRAINZ_ARTISTID: "musicbrainz_artistid",
	MUSICBRAINZ_ALBUMARTISTID: "musicbrainz_albumartistid",
	MUSICBRAINZ_RELEASEGROUPID: "musicbrainz_releasegroupid",
	MUSICBRAINZ_WORKID: "musicbrainz_workid",
	MUSICBRAINZ_TRMID: "musicbrainz_trmid",
	MUSICBRAINZ_DISCID: "musicbrainz_discid",
	Acoustid_Id: "acoustid_id",
	ACOUSTID_FINGERPRINT: "acoustid_fingerprint",
	MUSICIP_PUID: "musicip_puid",
	Weblink: "website",
	REPLAYGAIN_TRACK_GAIN: "replaygain_track_gain",
	REPLAYGAIN_TRACK_PEAK: "replaygain_track_peak",
	MP3GAIN_MINMAX: "replaygain_track_minmax",
	MP3GAIN_UNDO: "replaygain_undo"
};
var APEv2TagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super(["APEv2"], apev2TagMap);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/mp4/MP4TagMapper.js
/**
* Ref: https://github.com/sergiomb2/libmp4v2/wiki/iTunesMetadata
*/
const mp4TagMap = {
	"©nam": "title",
	"©ART": "artist",
	aART: "albumartist",
	"----:com.apple.iTunes:Band": "albumartist",
	"©alb": "album",
	"©day": "date",
	"©cmt": "comment",
	"©com": "comment",
	trkn: "track",
	disk: "disk",
	"©gen": "genre",
	covr: "picture",
	"©wrt": "composer",
	"©lyr": "lyrics",
	soal: "albumsort",
	sonm: "titlesort",
	soar: "artistsort",
	soaa: "albumartistsort",
	soco: "composersort",
	"----:com.apple.iTunes:LYRICIST": "lyricist",
	"----:com.apple.iTunes:CONDUCTOR": "conductor",
	"----:com.apple.iTunes:REMIXER": "remixer",
	"----:com.apple.iTunes:ENGINEER": "engineer",
	"----:com.apple.iTunes:PRODUCER": "producer",
	"----:com.apple.iTunes:DJMIXER": "djmixer",
	"----:com.apple.iTunes:MIXER": "mixer",
	"----:com.apple.iTunes:LABEL": "label",
	"©grp": "grouping",
	"----:com.apple.iTunes:SUBTITLE": "subtitle",
	"----:com.apple.iTunes:DISCSUBTITLE": "discsubtitle",
	cpil: "compilation",
	tmpo: "bpm",
	"----:com.apple.iTunes:MOOD": "mood",
	"----:com.apple.iTunes:MEDIA": "media",
	"----:com.apple.iTunes:CATALOGNUMBER": "catalognumber",
	tvsh: "tvShow",
	tvsn: "tvSeason",
	tves: "tvEpisode",
	sosn: "tvShowSort",
	tven: "tvEpisodeId",
	tvnn: "tvNetwork",
	pcst: "podcast",
	purl: "podcasturl",
	"----:com.apple.iTunes:MusicBrainz Album Status": "releasestatus",
	"----:com.apple.iTunes:MusicBrainz Album Type": "releasetype",
	"----:com.apple.iTunes:MusicBrainz Album Release Country": "releasecountry",
	"----:com.apple.iTunes:SCRIPT": "script",
	"----:com.apple.iTunes:LANGUAGE": "language",
	cprt: "copyright",
	"©cpy": "copyright",
	"----:com.apple.iTunes:LICENSE": "license",
	"©too": "encodedby",
	pgap: "gapless",
	"----:com.apple.iTunes:BARCODE": "barcode",
	"----:com.apple.iTunes:ISRC": "isrc",
	"----:com.apple.iTunes:ASIN": "asin",
	"----:com.apple.iTunes:NOTES": "comment",
	"----:com.apple.iTunes:MusicBrainz Track Id": "musicbrainz_recordingid",
	"----:com.apple.iTunes:MusicBrainz Release Track Id": "musicbrainz_trackid",
	"----:com.apple.iTunes:MusicBrainz Album Id": "musicbrainz_albumid",
	"----:com.apple.iTunes:MusicBrainz Artist Id": "musicbrainz_artistid",
	"----:com.apple.iTunes:MusicBrainz Album Artist Id": "musicbrainz_albumartistid",
	"----:com.apple.iTunes:MusicBrainz Release Group Id": "musicbrainz_releasegroupid",
	"----:com.apple.iTunes:MusicBrainz Work Id": "musicbrainz_workid",
	"----:com.apple.iTunes:MusicBrainz TRM Id": "musicbrainz_trmid",
	"----:com.apple.iTunes:MusicBrainz Disc Id": "musicbrainz_discid",
	"----:com.apple.iTunes:Acoustid Id": "acoustid_id",
	"----:com.apple.iTunes:Acoustid Fingerprint": "acoustid_fingerprint",
	"----:com.apple.iTunes:MusicIP PUID": "musicip_puid",
	"----:com.apple.iTunes:fingerprint": "musicip_fingerprint",
	"----:com.apple.iTunes:replaygain_track_gain": "replaygain_track_gain",
	"----:com.apple.iTunes:replaygain_track_peak": "replaygain_track_peak",
	"----:com.apple.iTunes:replaygain_album_gain": "replaygain_album_gain",
	"----:com.apple.iTunes:replaygain_album_peak": "replaygain_album_peak",
	"----:com.apple.iTunes:replaygain_track_minmax": "replaygain_track_minmax",
	"----:com.apple.iTunes:replaygain_album_minmax": "replaygain_album_minmax",
	"----:com.apple.iTunes:replaygain_undo": "replaygain_undo",
	gnre: "genre",
	"----:com.apple.iTunes:ALBUMARTISTSORT": "albumartistsort",
	"----:com.apple.iTunes:ARTISTS": "artists",
	"----:com.apple.iTunes:ORIGINALDATE": "originaldate",
	"----:com.apple.iTunes:ORIGINALYEAR": "originalyear",
	"----:com.apple.iTunes:RELEASEDATE": "releasedate",
	desc: "description",
	ldes: "longDescription",
	"©mvn": "movement",
	"©mvi": "movementIndex",
	"©mvc": "movementTotal",
	"©wrk": "work",
	catg: "category",
	egid: "podcastId",
	hdvd: "hdVideo",
	keyw: "keywords",
	shwm: "showMovement",
	stik: "stik",
	rate: "rating"
};
const tagType = "iTunes";
var MP4TagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super([tagType], mp4TagMap);
	}
	postMap(tag, _warnings) {
		switch (tag.id) {
			case "rate":
				tag.value = {
					source: void 0,
					rating: Number.parseFloat(tag.value) / 100
				};
				break;
		}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/ogg/vorbis/VorbisTagMapper.js
/**
* Vorbis tag mappings
*
* Mapping from native header format to one or possibly more 'common' entries
* The common entries aim to read the same information from different media files
* independent of the underlying format
*/
const vorbisTagMap = {
	TITLE: "title",
	ARTIST: "artist",
	ARTISTS: "artists",
	ALBUMARTIST: "albumartist",
	"ALBUM ARTIST": "albumartist",
	ALBUM: "album",
	DATE: "date",
	ORIGINALDATE: "originaldate",
	ORIGINALYEAR: "originalyear",
	RELEASEDATE: "releasedate",
	COMMENT: "comment",
	TRACKNUMBER: "track",
	DISCNUMBER: "disk",
	GENRE: "genre",
	METADATA_BLOCK_PICTURE: "picture",
	COMPOSER: "composer",
	LYRICS: "lyrics",
	ALBUMSORT: "albumsort",
	TITLESORT: "titlesort",
	WORK: "work",
	ARTISTSORT: "artistsort",
	ALBUMARTISTSORT: "albumartistsort",
	COMPOSERSORT: "composersort",
	LYRICIST: "lyricist",
	WRITER: "writer",
	CONDUCTOR: "conductor",
	REMIXER: "remixer",
	ARRANGER: "arranger",
	ENGINEER: "engineer",
	PRODUCER: "producer",
	DJMIXER: "djmixer",
	MIXER: "mixer",
	LABEL: "label",
	GROUPING: "grouping",
	SUBTITLE: "subtitle",
	DISCSUBTITLE: "discsubtitle",
	TRACKTOTAL: "totaltracks",
	DISCTOTAL: "totaldiscs",
	COMPILATION: "compilation",
	RATING: "rating",
	BPM: "bpm",
	KEY: "key",
	MOOD: "mood",
	MEDIA: "media",
	CATALOGNUMBER: "catalognumber",
	RELEASESTATUS: "releasestatus",
	RELEASETYPE: "releasetype",
	RELEASECOUNTRY: "releasecountry",
	SCRIPT: "script",
	LANGUAGE: "language",
	COPYRIGHT: "copyright",
	LICENSE: "license",
	ENCODEDBY: "encodedby",
	ENCODERSETTINGS: "encodersettings",
	BARCODE: "barcode",
	ISRC: "isrc",
	ASIN: "asin",
	MUSICBRAINZ_TRACKID: "musicbrainz_recordingid",
	MUSICBRAINZ_RELEASETRACKID: "musicbrainz_trackid",
	MUSICBRAINZ_ALBUMID: "musicbrainz_albumid",
	MUSICBRAINZ_ARTISTID: "musicbrainz_artistid",
	MUSICBRAINZ_ALBUMARTISTID: "musicbrainz_albumartistid",
	MUSICBRAINZ_RELEASEGROUPID: "musicbrainz_releasegroupid",
	MUSICBRAINZ_WORKID: "musicbrainz_workid",
	MUSICBRAINZ_TRMID: "musicbrainz_trmid",
	MUSICBRAINZ_DISCID: "musicbrainz_discid",
	ACOUSTID_ID: "acoustid_id",
	ACOUSTID_ID_FINGERPRINT: "acoustid_fingerprint",
	MUSICIP_PUID: "musicip_puid",
	WEBSITE: "website",
	NOTES: "notes",
	TOTALTRACKS: "totaltracks",
	TOTALDISCS: "totaldiscs",
	DISCOGS_ARTIST_ID: "discogs_artist_id",
	DISCOGS_ARTISTS: "artists",
	DISCOGS_ARTIST_NAME: "artists",
	DISCOGS_ALBUM_ARTISTS: "albumartist",
	DISCOGS_CATALOG: "catalognumber",
	DISCOGS_COUNTRY: "releasecountry",
	DISCOGS_DATE: "originaldate",
	DISCOGS_LABEL: "label",
	DISCOGS_LABEL_ID: "discogs_label_id",
	DISCOGS_MASTER_RELEASE_ID: "discogs_master_release_id",
	DISCOGS_RATING: "discogs_rating",
	DISCOGS_RELEASED: "date",
	DISCOGS_RELEASE_ID: "discogs_release_id",
	DISCOGS_VOTES: "discogs_votes",
	CATALOGID: "catalognumber",
	STYLE: "genre",
	REPLAYGAIN_TRACK_GAIN: "replaygain_track_gain",
	REPLAYGAIN_TRACK_PEAK: "replaygain_track_peak",
	REPLAYGAIN_ALBUM_GAIN: "replaygain_album_gain",
	REPLAYGAIN_ALBUM_PEAK: "replaygain_album_peak",
	REPLAYGAIN_MINMAX: "replaygain_track_minmax",
	REPLAYGAIN_ALBUM_MINMAX: "replaygain_album_minmax",
	REPLAYGAIN_UNDO: "replaygain_undo"
};
var VorbisTagMapper = class VorbisTagMapper extends CommonTagMapper {
	static toRating(email, rating, maxScore) {
		return {
			source: email ? email.toLowerCase() : void 0,
			rating: Number.parseFloat(rating) / maxScore * CommonTagMapper.maxRatingScore
		};
	}
	constructor() {
		super(["vorbis"], vorbisTagMap);
	}
	postMap(tag) {
		if (tag.id === "RATING") {tag.value = VorbisTagMapper.toRating(void 0, tag.value, 100);}
		else if (tag.id.indexOf("RATING:") === 0) {
			const keys = tag.id.split(":");
			tag.value = VorbisTagMapper.toRating(keys[1], tag.value, 1);
			tag.id = keys[0];
		}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/riff/RiffInfoTagMap.js
/**
* RIFF Info Tags; part of the EXIF 2.3
* Ref: http://owl.phy.queensu.ca/~phil/exiftool/TagNames/RIFF.html#Info
*/
const riffInfoTagMap = {
	IART: "artist",
	ICRD: "date",
	INAM: "title",
	TITL: "title",
	IPRD: "album",
	ITRK: "track",
	IPRT: "track",
	COMM: "comment",
	ICMT: "comment",
	ICNT: "releasecountry",
	GNRE: "genre",
	IWRI: "writer",
	RATE: "rating",
	YEAR: "year",
	ISFT: "encodedby",
	CODE: "encodedby",
	TURL: "website",
	IGNR: "genre",
	IENG: "engineer",
	ITCH: "technician",
	IMED: "media",
	IRPD: "album"
};
var RiffInfoTagMapper = class extends CommonTagMapper {
	constructor() {
		super(["exif"], riffInfoTagMap);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/matroska/MatroskaTagMapper.js
/**
* EBML Tag map
*/
const ebmlTagMap = {
	"segment:title": "title",
	"album:ARTIST": "albumartist",
	"album:ARTISTSORT": "albumartistsort",
	"album:TITLE": "album",
	"album:DATE_RECORDED": "originaldate",
	"album:DATE_RELEASED": "releasedate",
	"album:PART_NUMBER": "disk",
	"album:TOTAL_PARTS": "totaltracks",
	"track:ARTIST": "artist",
	"track:ARTISTSORT": "artistsort",
	"track:TITLE": "title",
	"track:PART_NUMBER": "track",
	"track:MUSICBRAINZ_TRACKID": "musicbrainz_recordingid",
	"track:MUSICBRAINZ_ALBUMID": "musicbrainz_albumid",
	"track:MUSICBRAINZ_ARTISTID": "musicbrainz_artistid",
	"track:PUBLISHER": "label",
	"track:GENRE": "genre",
	"track:ENCODER": "encodedby",
	"track:ENCODER_OPTIONS": "encodersettings",
	"edition:TOTAL_PARTS": "totaldiscs",
	picture: "picture"
};
var MatroskaTagMapper = class extends CaseInsensitiveTagMap {
	constructor() {
		super(["matroska"], ebmlTagMap);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/aiff/AiffTagMap.js
/**
* ID3v1 tag mappings
*/
const tagMap = {
	NAME: "title",
	AUTH: "artist",
	"(c) ": "copyright",
	ANNO: "comment"
};
var AiffTagMapper = class extends CommonTagMapper {
	constructor() {
		super(["AIFF"], tagMap);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/common/CombinedTagMapper.js
var CombinedTagMapper = class {
	constructor() {
		this.tagMappers = {};
		[
			new ID3v1TagMapper(),
			new ID3v22TagMapper(),
			new ID3v24TagMapper(),
			new MP4TagMapper(),
			new MP4TagMapper(),
			new VorbisTagMapper(),
			new APEv2TagMapper(),
			new AsfTagMapper(),
			new RiffInfoTagMapper(),
			new MatroskaTagMapper(),
			new AiffTagMapper()
		].forEach((mapper) => {
			this.registerTagMapper(mapper);
		});
	}
	/**
	* Convert native to generic (common) tags
	* @param tagType Originating tag format
	* @param tag     Native tag to map to a generic tag id
	* @param warnings
	* @return Generic tag result (output of this function)
	*/
	mapTag(tagType, tag, warnings) {
		if (this.tagMappers[tagType]) {return this.tagMappers[tagType].mapGenericTag(tag, warnings);}
		throw new InternalParserError(`No generic tag mapper defined for tag-format: ${tagType}`);
	}
	registerTagMapper(genericTagMapper) {
		for (const tagType of genericTagMapper.tagTypes) {this.tagMappers[tagType] = genericTagMapper;}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/lrc/LyricsParser.js
const TIMESTAMP_REGEX = /\[(\d{2}):(\d{2})\.(\d{2,3})]/;
function parseLyrics(input) {
	if (TIMESTAMP_REGEX.test(input)) {return parseLrc(input);}
	return toUnsyncedLyrics(input);
}
function toUnsyncedLyrics(lyrics) {
	return {
		contentType: LyricsContentType.lyrics,
		timeStampFormat: TimestampFormat.notSynchronized,
		text: lyrics.trim(),
		syncText: []
	};
}
/**
* Parse LRC (Lyrics) formatted text
* Ref: https://en.wikipedia.org/wiki/LRC_(file_format)
* @param lrcString
*/
function parseLrc(lrcString) {
	const lines = lrcString.split("\n");
	const syncText = [];
	for (const line of lines) {
		const match = line.match(TIMESTAMP_REGEX);
		if (match) {
			const minutes = Number.parseInt(match[1], 10);
			const seconds = Number.parseInt(match[2], 10);
			const ms = match[3].length === 3 ? Number.parseInt(match[3], 10) : Number.parseInt(match[3], 10) * 10;
			const timestamp = (minutes * 60 + seconds) * 1e3 + ms;
			const text = line.replace(TIMESTAMP_REGEX, "").trim();
			syncText.push({
				timestamp,
				text
			});
		}
	}
	return {
		contentType: LyricsContentType.lyrics,
		timeStampFormat: TimestampFormat.milliseconds,
		text: syncText.map((line) => line.text).join("\n"),
		syncText
	};
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/common/MetadataCollector.js
const debug$2 = (0, import_src.default)("music-metadata:collector");
const TagPriority = [
	"matroska",
	"APEv2",
	"vorbis",
	"ID3v2.4",
	"ID3v2.3",
	"ID3v2.2",
	"exif",
	"asf",
	"iTunes",
	"AIFF",
	"ID3v1"
];
/**
* Provided to the parser to uodate the metadata result.
* Responsible for triggering async updates
*/
var MetadataCollector = class {
	constructor(opts) {
		this.format = {
			tagTypes: [],
			trackInfo: []
		};
		this.native = {};
		this.common = {
			track: {
				no: null,
				of: null
			},
			disk: {
				no: null,
				of: null
			},
			movementIndex: {
				no: null,
				of: null
			}
		};
		this.quality = { warnings: [] };
		/**
		* Keeps track of origin priority for each mapped id
		*/
		this.commonOrigin = {};
		/**
		* Maps a tag type to a priority
		*/
		this.originPriority = {};
		this.tagMapper = new CombinedTagMapper();
		this.opts = opts;
		let priority = 1;
		for (const tagType of TagPriority) {this.originPriority[tagType] = priority++;}
		this.originPriority.artificial = 500;
		this.originPriority.id3v1 = 600;
	}
	/**
	* @returns {boolean} true if one or more tags have been found
	*/
	hasAny() {
		return Object.keys(this.native).length > 0;
	}
	addStreamInfo(streamInfo) {
		debug$2(`streamInfo: type=${streamInfo.type ? TrackTypeValueToKeyMap[streamInfo.type] : "?"}, codec=${streamInfo.codecName}`);
		this.format.trackInfo.push(streamInfo);
	}
	setFormat(key, value) {
		debug$2(`format: ${key} = ${value}`);
		this.format[key] = value;
		if (this.opts?.observer) {this.opts.observer({
			metadata: this,
			tag: {
				type: "format",
				id: key,
				value
			}
		});}
	}
	setAudioOnly() {
		this.setFormat("hasAudio", true);
		this.setFormat("hasVideo", false);
	}
	async addTag(tagType, tagId, value) {
		debug$2(`tag ${tagType}.${tagId} = ${value}`);
		if (!this.native[tagType]) {
			this.format.tagTypes.push(tagType);
			this.native[tagType] = [];
		}
		this.native[tagType].push({
			id: tagId,
			value
		});
		await this.toCommon(tagType, tagId, value);
	}
	addWarning(warning) {
		this.quality.warnings.push({ message: warning });
	}
	async postMap(tagType, tag) {
		switch (tag.id) {
			case "artist": return this.handleSingularArtistTag(tagType, tag, "artist", "artists");
			case "albumartist": return this.handleSingularArtistTag(tagType, tag, "albumartist", "albumartists");
			case "artists": return this.handlePluralArtistTag(tagType, tag, "artist", "artists");
			case "albumartists": return this.handlePluralArtistTag(tagType, tag, "albumartist", "albumartists");
			case "picture": return this.postFixPicture(tag.value).then((picture) => {
				if (picture !== null) {
					tag.value = picture;
					this.setGenericTag(tagType, tag);
				}
			});
			case "totaltracks":
				this.common.track.of = CommonTagMapper.toIntOrNull(tag.value);
				return;
			case "totaldiscs":
				this.common.disk.of = CommonTagMapper.toIntOrNull(tag.value);
				return;
			case "movementTotal":
				this.common.movementIndex.of = CommonTagMapper.toIntOrNull(tag.value);
				return;
			case "track":
			case "disk":
			case "movementIndex": {
				const of = this.common[tag.id].of;
				this.common[tag.id] = CommonTagMapper.normalizeTrack(tag.value);
				this.common[tag.id].of = of != null ? of : this.common[tag.id].of;
				return;
			}
			case "bpm":
			case "year":
			case "originalyear":
				tag.value = Number.parseInt(tag.value, 10);
				break;
			case "date": {
				const year = Number.parseInt(tag.value.substr(0, 4), 10);
				if (!Number.isNaN(year)) {this.common.year = year;}
				break;
			}
			case "discogs_label_id":
			case "discogs_release_id":
			case "discogs_master_release_id":
			case "discogs_artist_id":
			case "discogs_votes":
				tag.value = typeof tag.value === "string" ? Number.parseInt(tag.value, 10) : tag.value;
				break;
			case "replaygain_track_gain":
			case "replaygain_track_peak":
			case "replaygain_album_gain":
			case "replaygain_album_peak":
				tag.value = toRatio(tag.value);
				break;
			case "replaygain_track_minmax":
				tag.value = tag.value.split(",").map((v) => Number.parseInt(v, 10));
				break;
			case "replaygain_undo": {
				const minMix = tag.value.split(",").map((v) => Number.parseInt(v, 10));
				tag.value = {
					leftChannel: minMix[0],
					rightChannel: minMix[1]
				};
				break;
			}
			case "gapless":
			case "compilation":
			case "podcast":
			case "showMovement":
				tag.value = tag.value === "1" || tag.value === 1;
				break;
			case "isrc": {
				const commonTag = this.common[tag.id];
				if (commonTag && commonTag.indexOf(tag.value) !== -1) {return;}
				break;
			}
			case "comment":
				if (typeof tag.value === "string") {tag.value = { text: tag.value };}
				if (tag.value.descriptor === "iTunPGAP") {this.setGenericTag(tagType, {
					id: "gapless",
					value: tag.value.text === "1"
				});}
				break;
			case "lyrics":
				if (typeof tag.value === "string") {tag.value = parseLyrics(tag.value);}
				break;
			default:
		}
		if (tag.value !== null) {this.setGenericTag(tagType, tag);}
	}
	/**
	* Convert native tags to common tags
	* @returns {IAudioMetadata} Native + common tags
	*/
	toCommonMetadata() {
		return {
			format: this.format,
			native: this.native,
			quality: this.quality,
			common: this.common
		};
	}
	/**
	* Handle singular artist tags (artist, albumartist) and cross-populate to plural form
	*/
	handleSingularArtistTag(tagType, tag, singularId, pluralId) {
		if (this.commonOrigin[singularId] === this.originPriority[tagType]) {return this.postMap("artificial", {
			id: pluralId,
			value: tag.value
		});}
		if (!this.common[pluralId]) {this.setGenericTag("artificial", {
			id: pluralId,
			value: tag.value
		});}
		this.setGenericTag(tagType, tag);
	}
	/**
	* Handle plural artist tags (artists, albumartists) and cross-populate to singular form
	*/
	handlePluralArtistTag(tagType, tag, singularId, pluralId) {
		if (!this.common[singularId] || this.commonOrigin[singularId] === this.originPriority.artificial) {
			if (!this.common[pluralId] || this.common[pluralId].indexOf(tag.value) === -1) {
				const value = joinArtists((this.common[pluralId] || []).concat([tag.value]));
				this.setGenericTag("artificial", {
					id: singularId,
					value
				});
			}
		}
		this.setGenericTag(tagType, tag);
	}
	/**
	* Fix some common issues with picture object
	* @param picture Picture
	*/
	async postFixPicture(picture) {
		if (picture.data && picture.data.length > 0) {
			if (!picture.format) {
				const fileType = await fileTypeFromBuffer(Uint8Array.from(picture.data));
				if (fileType) {picture.format = fileType.mime;}
				else {return null;}
			}
			picture.format = picture.format.toLocaleLowerCase();
			switch (picture.format) {
				case "image/jpg": picture.format = "image/jpeg";
			}
			return picture;
		}
		this.addWarning("Empty picture tag found");
		return null;
	}
	/**
	* Convert native tag to common tags
	*/
	async toCommon(tagType, tagId, value) {
		const tag = {
			id: tagId,
			value
		};
		const genericTag = this.tagMapper.mapTag(tagType, tag, this);
		if (genericTag) {await this.postMap(tagType, genericTag);}
	}
	/**
	* Set generic tag
	*/
	setGenericTag(tagType, tag) {
		debug$2(`common.${tag.id} = ${tag.value}`);
		const prio0 = this.commonOrigin[tag.id] || 1e3;
		const prio1 = this.originPriority[tagType];
		if (isSingleton(tag.id)) {if (prio1 <= prio0) {
			this.common[tag.id] = tag.value;
			this.commonOrigin[tag.id] = prio1;
		} else return debug$2(`Ignore native tag (singleton): ${tagType}.${tag.id} = ${tag.value}`);}
		else if (prio1 === prio0) {if (!isUnique(tag.id) || this.common[tag.id].indexOf(tag.value) === -1) this.common[tag.id].push(tag.value);
		else debug$2(`Ignore duplicate value: ${tagType}.${tag.id} = ${tag.value}`);}
		else if (prio1 < prio0) {
			this.common[tag.id] = [tag.value];
			this.commonOrigin[tag.id] = prio1;
		} else {return debug$2(`Ignore native tag (list): ${tagType}.${tag.id} = ${tag.value}`);}
		if (this.opts?.observer) {this.opts.observer({
			metadata: this,
			tag: {
				type: "common",
				id: tag.id,
				value: tag.value
			}
		});}
	}
};
function joinArtists(artists) {
	if (artists.length > 2) {return `${artists.slice(0, artists.length - 1).join(", ")} & ${artists[artists.length - 1]}`;}
	return artists.join(" & ");
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/mpeg/MpegLoader.js
const mpegParserLoader = {
	parserType: "mpeg",
	extensions: [
		".mp2",
		".mp3",
		".m2a",
		".aac",
		"aacp"
	],
	mimeTypes: [
		"audio/mpeg",
		"audio/mp3",
		"audio/aacs",
		"audio/aacp"
	],
	async load() {
		return (await import("./MpegParser-CE6YbP6g.js")).MpegParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/apev2/Apev2Loader.js
const apeParserLoader = {
	parserType: "apev2",
	extensions: [".ape"],
	mimeTypes: ["audio/ape", "audio/monkeys-audio"],
	async load() {
		return (await import("./APEv2Parser-VklX-9vv.js")).APEv2Parser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/asf/AsfLoader.js
const asfParserLoader = {
	parserType: "asf",
	extensions: [
		".asf",
		".wma",
		".wmv"
	],
	mimeTypes: [
		"audio/ms-wma",
		"video/ms-wmv",
		"audio/ms-asf",
		"video/ms-asf",
		"application/vnd.ms-asf"
	],
	async load() {
		return (await import("./AsfParser-D0yiDWIf.js")).AsfParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/dsdiff/DsdiffLoader.js
const dsdiffParserLoader = {
	parserType: "dsdiff",
	extensions: [".dff"],
	mimeTypes: ["audio/dsf", "audio/dsd"],
	async load() {
		return (await import("./DsdiffParser-DLlwljc8.js")).DsdiffParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/aiff/AiffLoader.js
const aiffParserLoader = {
	parserType: "aiff",
	extensions: [
		".aif",
		"aiff",
		"aifc"
	],
	mimeTypes: [
		"audio/aiff",
		"audio/aif",
		"audio/aifc",
		"application/aiff"
	],
	async load() {
		return (await import("./AiffParser-DS86zL8N.js")).AIFFParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/dsf/DsfLoader.js
const dsfParserLoader = {
	parserType: "dsf",
	extensions: [".dsf"],
	mimeTypes: ["audio/dsf"],
	async load() {
		return (await import("./DsfParser-DIIyPYE-.js")).DsfParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/flac/FlacLoader.js
const flacParserLoader = {
	parserType: "flac",
	extensions: [".flac"],
	mimeTypes: ["audio/flac"],
	async load() {
		return (await import("./FlacParser-CWzs0RYu.js")).FlacParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/matroska/MatroskaLoader.js
const matroskaParserLoader = {
	parserType: "matroska",
	extensions: [
		".mka",
		".mkv",
		".mk3d",
		".mks",
		"webm"
	],
	mimeTypes: [
		"audio/matroska",
		"video/matroska",
		"audio/webm",
		"video/webm"
	],
	async load() {
		return (await import("./MatroskaParser-CX-YzCI0.js")).MatroskaParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/mp4/Mp4Loader.js
const mp4ParserLoader = {
	parserType: "mp4",
	extensions: [
		".mp4",
		".m4a",
		".m4b",
		".m4pa",
		"m4v",
		"m4r",
		"3gp",
		".mov",
		".movie",
		".qt"
	],
	mimeTypes: [
		"audio/mp4",
		"audio/m4a",
		"video/m4v",
		"video/mp4",
		"video/quicktime"
	],
	async load() {
		return (await import("./MP4Parser-DeJsIR_o.js")).MP4Parser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/musepack/MusepackLoader.js
const musepackParserLoader = {
	parserType: "musepack",
	extensions: [".mpc"],
	mimeTypes: ["audio/musepack"],
	async load() {
		return (await import("./MusepackParser-CTCRF9Ep.js")).MusepackParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/ogg/OggLoader.js
const oggParserLoader = {
	parserType: "ogg",
	extensions: [
		".ogg",
		".ogv",
		".oga",
		".ogm",
		".ogx",
		".opus",
		".spx"
	],
	mimeTypes: [
		"audio/ogg",
		"audio/opus",
		"audio/speex",
		"video/ogg"
	],
	async load() {
		return (await import("./OggParser-CXdOVF5b.js")).OggParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/wavpack/WavPackLoader.js
const wavpackParserLoader = {
	parserType: "wavpack",
	extensions: [".wv", ".wvp"],
	mimeTypes: ["audio/wavpack"],
	async load() {
		return (await import("./WavPackParser-IIn7blwS.js")).WavPackParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/wav/WaveLoader.js
const riffParserLoader = {
	parserType: "riff",
	extensions: [
		".wav",
		"wave",
		".bwf"
	],
	mimeTypes: [
		"audio/vnd.wave",
		"audio/wav",
		"audio/wave"
	],
	async load() {
		return (await import("./WaveParser-DMZefOn1.js")).WaveParser;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/ParserFactory.js
const debug$1 = (0, import_src.default)("music-metadata:parser:factory");
function parseHttpContentType(contentType) {
	const type = import_content_type.parse(contentType);
	const mime = (0, import_media_typer.parse)(type.type);
	return {
		type: mime.type,
		subtype: mime.subtype,
		suffix: mime.suffix,
		parameters: type.parameters
	};
}
var ParserFactory = class {
	constructor() {
		this.parsers = [];
		[
			flacParserLoader,
			mpegParserLoader,
			apeParserLoader,
			mp4ParserLoader,
			matroskaParserLoader,
			riffParserLoader,
			oggParserLoader,
			asfParserLoader,
			aiffParserLoader,
			wavpackParserLoader,
			musepackParserLoader,
			dsfParserLoader,
			dsdiffParserLoader
		].forEach((parser) => {
			this.registerParser(parser);
		});
	}
	registerParser(parser) {
		this.parsers.push(parser);
	}
	async parse(tokenizer, parserLoader, opts) {
		if (tokenizer.supportsRandomAccess()) {
			debug$1("tokenizer supports random-access, scanning for appending headers");
			await scanAppendingHeaders(tokenizer, opts);
		} else {debug$1("tokenizer does not support random-access, cannot scan for appending headers");}
		if (!parserLoader) {
			const buf = new Uint8Array(4100);
			if (tokenizer.fileInfo.mimeType) {parserLoader = this.findLoaderForContentType(tokenizer.fileInfo.mimeType);}
			if (!parserLoader && tokenizer.fileInfo.path) {parserLoader = this.findLoaderForExtension(tokenizer.fileInfo.path);}
			if (!parserLoader) {
				debug$1("Guess parser on content...");
				await tokenizer.peekBuffer(buf, { mayBeLess: true });
				const guessedType = await fileTypeFromBuffer(buf, { mpegOffsetTolerance: 10 });
				if (!guessedType || !guessedType.mime) {throw new CouldNotDetermineFileTypeError("Failed to determine audio format");}
				debug$1(`Guessed file type is mime=${guessedType.mime}, extension=${guessedType.ext}`);
				parserLoader = this.findLoaderForContentType(guessedType.mime);
				if (!parserLoader) {throw new UnsupportedFileTypeError(`Guessed MIME-type not supported: ${guessedType.mime}`);}
			}
		}
		debug$1(`Loading ${parserLoader.parserType} parser...`);
		const metadata = new MetadataCollector(opts);
		const parser = new (await (parserLoader.load()))(metadata, tokenizer, opts ?? {});
		debug$1(`Parser ${parserLoader.parserType} loaded`);
		await parser.parse();
		if (metadata.format.trackInfo) {
			if (metadata.format.hasAudio === void 0) {metadata.setFormat("hasAudio", !!metadata.format.trackInfo.find((track) => track.type === TrackType.audio));}
			if (metadata.format.hasVideo === void 0) {metadata.setFormat("hasVideo", !!metadata.format.trackInfo.find((track) => track.type === TrackType.video));}
		}
		return metadata.toCommonMetadata();
	}
	/**
	* @param filePath - Path, filename or extension to audio file
	* @return Parser submodule name
	*/
	findLoaderForExtension(filePath) {
		if (!filePath) {return;}
		const extension = getExtension(filePath).toLocaleLowerCase() || filePath;
		return this.parsers.find((parser) => parser.extensions.indexOf(extension) !== -1);
	}
	findLoaderForContentType(httpContentType) {
		let mime;
		if (!httpContentType) {return;}
		try {
			mime = parseHttpContentType(httpContentType);
		} catch (_err) {
			debug$1(`Invalid HTTP Content-Type header value: ${httpContentType}`);
			return;
		}
		const subType = mime.subtype.indexOf("x-") === 0 ? mime.subtype.substring(2) : mime.subtype;
		return this.parsers.find((parser) => parser.mimeTypes.find((loader) => loader.indexOf(`${mime.type}/${subType}`) !== -1));
	}
	getSupportedMimeTypes() {
		const mimeTypeSet = /* @__PURE__ */ new Set();
		this.parsers.forEach((loader) => {
			loader.mimeTypes.forEach((mimeType) => {
				mimeTypeSet.add(mimeType);
				mimeTypeSet.add(mimeType.replace("/", "/x-"));
			});
		});
		return Array.from(mimeTypeSet);
	}
};
function getExtension(fname) {
	const i = fname.lastIndexOf(".");
	return i === -1 ? "" : fname.substring(i);
}
async function getLyricsHeaderLength(tokenizer) {
	const fileSize = tokenizer.fileInfo.size;
	if (fileSize >= 143) {
		const buf = new Uint8Array(15);
		const position = tokenizer.position;
		await tokenizer.readBuffer(buf, { position: fileSize - 143 });
		tokenizer.setPosition(position);
		const txt = textDecode(buf, "latin1");
		if (txt.substring(6) === "LYRICS200") {return Number.parseInt(txt.substring(0, 6), 10) + 15;}
	}
	return 0;
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/core.js
/**
* Primary entry point, Node.js specific entry point is MusepackParser.ts
*/
/**
* Parse audio from memory
* @param uint8Array - Uint8Array holding audio data
* @param fileInfo - File information object or MIME-type string
* @param options - Parsing options
* @returns Metadata
* Ref: https://github.com/Borewit/strtok3/blob/e6938c81ff685074d5eb3064a11c0b03ca934c1d/src/index.ts#L15
*/
async function parseBuffer(uint8Array, fileInfo, options = {}) {
	return parseFromTokenizer(fromBuffer(uint8Array, { fileInfo: typeof fileInfo === "string" ? { mimeType: fileInfo } : fileInfo }), options);
}
/**
* Parse audio from ITokenizer source
* @param tokenizer - Audio source implementing the tokenizer interface
* @param options - Parsing options
* @returns Metadata
*/
function parseFromTokenizer(tokenizer, options) {
	return new ParserFactory().parse(tokenizer, void 0, options);
}
async function scanAppendingHeaders(tokenizer, options = {}) {
	let apeOffset = tokenizer.fileInfo.size;
	if (await hasID3v1Header(tokenizer)) {
		apeOffset -= 128;
		const lyricsLen = await getLyricsHeaderLength(tokenizer);
		apeOffset -= lyricsLen;
	}
	options.apeHeader = await APEv2Parser.findApeFooterOffset(tokenizer, apeOffset);
}
(0, import_src.default)("music-metadata:parser");
//#endregion
export { parseBuffer };
