import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { E as UINT8, _ as StringType, k as textDecode, t as BasicParser } from "./BasicParser-CrFlghez.js";
import { u as trimRightNull } from "./Util-D0u1g-Ih.js";
import { t as APEv2Parser } from "./APEv2Parser-CGbu4tbE.js";
const debug = (0, (/* @__PURE__ */ __toESM(require_src(), 1)).default)("music-metadata:parser:ID3v1");
/**
* ID3v1 Genre mappings
* Ref: https://de.wikipedia.org/wiki/Liste_der_ID3v1-Genres
*/
const Genres = [
	"Blues",
	"Classic Rock",
	"Country",
	"Dance",
	"Disco",
	"Funk",
	"Grunge",
	"Hip-Hop",
	"Jazz",
	"Metal",
	"New Age",
	"Oldies",
	"Other",
	"Pop",
	"R&B",
	"Rap",
	"Reggae",
	"Rock",
	"Techno",
	"Industrial",
	"Alternative",
	"Ska",
	"Death Metal",
	"Pranks",
	"Soundtrack",
	"Euro-Techno",
	"Ambient",
	"Trip-Hop",
	"Vocal",
	"Jazz+Funk",
	"Fusion",
	"Trance",
	"Classical",
	"Instrumental",
	"Acid",
	"House",
	"Game",
	"Sound Clip",
	"Gospel",
	"Noise",
	"Alt. Rock",
	"Bass",
	"Soul",
	"Punk",
	"Space",
	"Meditative",
	"Instrumental Pop",
	"Instrumental Rock",
	"Ethnic",
	"Gothic",
	"Darkwave",
	"Techno-Industrial",
	"Electronic",
	"Pop-Folk",
	"Eurodance",
	"Dream",
	"Southern Rock",
	"Comedy",
	"Cult",
	"Gangsta Rap",
	"Top 40",
	"Christian Rap",
	"Pop/Funk",
	"Jungle",
	"Native American",
	"Cabaret",
	"New Wave",
	"Psychedelic",
	"Rave",
	"Showtunes",
	"Trailer",
	"Lo-Fi",
	"Tribal",
	"Acid Punk",
	"Acid Jazz",
	"Polka",
	"Retro",
	"Musical",
	"Rock & Roll",
	"Hard Rock",
	"Folk",
	"Folk/Rock",
	"National Folk",
	"Swing",
	"Fast-Fusion",
	"Bebob",
	"Latin",
	"Revival",
	"Celtic",
	"Bluegrass",
	"Avantgarde",
	"Gothic Rock",
	"Progressive Rock",
	"Psychedelic Rock",
	"Symphonic Rock",
	"Slow Rock",
	"Big Band",
	"Chorus",
	"Easy Listening",
	"Acoustic",
	"Humour",
	"Speech",
	"Chanson",
	"Opera",
	"Chamber Music",
	"Sonata",
	"Symphony",
	"Booty Bass",
	"Primus",
	"Porn Groove",
	"Satire",
	"Slow Jam",
	"Club",
	"Tango",
	"Samba",
	"Folklore",
	"Ballad",
	"Power Ballad",
	"Rhythmic Soul",
	"Freestyle",
	"Duet",
	"Punk Rock",
	"Drum Solo",
	"A Cappella",
	"Euro-House",
	"Dance Hall",
	"Goa",
	"Drum & Bass",
	"Club-House",
	"Hardcore",
	"Terror",
	"Indie",
	"BritPop",
	"Negerpunk",
	"Polsk Punk",
	"Beat",
	"Christian Gangsta Rap",
	"Heavy Metal",
	"Black Metal",
	"Crossover",
	"Contemporary Christian",
	"Christian Rock",
	"Merengue",
	"Salsa",
	"Thrash Metal",
	"Anime",
	"JPop",
	"Synthpop",
	"Abstract",
	"Art Rock",
	"Baroque",
	"Bhangra",
	"Big Beat",
	"Breakbeat",
	"Chillout",
	"Downtempo",
	"Dub",
	"EBM",
	"Eclectic",
	"Electro",
	"Electroclash",
	"Emo",
	"Experimental",
	"Garage",
	"Global",
	"IDM",
	"Illbient",
	"Industro-Goth",
	"Jam Band",
	"Krautrock",
	"Leftfield",
	"Lounge",
	"Math Rock",
	"New Romantic",
	"Nu-Breakz",
	"Post-Punk",
	"Post-Rock",
	"Psytrance",
	"Shoegaze",
	"Space Rock",
	"Trop Rock",
	"World Music",
	"Neoclassical",
	"Audiobook",
	"Audio Theatre",
	"Neue Deutsche Welle",
	"Podcast",
	"Indie Rock",
	"G-Funk",
	"Dubstep",
	"Garage Rock",
	"Psybient"
];
/**
* Spec: http://id3.org/ID3v1
* Wiki: https://en.wikipedia.org/wiki/ID3
*/
const Iid3v1Token = {
	len: 128,
	get: (buf, off) => {
		const header = new Id3v1StringType(3).get(buf, off);
		return header === "TAG" ? {
			header,
			title: new Id3v1StringType(30).get(buf, off + 3),
			artist: new Id3v1StringType(30).get(buf, off + 33),
			album: new Id3v1StringType(30).get(buf, off + 63),
			year: new Id3v1StringType(4).get(buf, off + 93),
			comment: new Id3v1StringType(28).get(buf, off + 97),
			zeroByte: UINT8.get(buf, off + 127),
			track: UINT8.get(buf, off + 126),
			genre: UINT8.get(buf, off + 127)
		} : null;
	}
};
var Id3v1StringType = class {
	constructor(len) {
		this.len = len;
		this.stringType = new StringType(len, "latin1");
	}
	get(buf, off) {
		let value = this.stringType.get(buf, off);
		value = trimRightNull(value);
		value = value.trim();
		return value.length > 0 ? value : void 0;
	}
};
var ID3v1Parser = class ID3v1Parser extends BasicParser {
	constructor(metadata, tokenizer, options) {
		super(metadata, tokenizer, options);
		this.apeHeader = options.apeHeader;
	}
	static getGenre(genreIndex) {
		if (genreIndex < Genres.length) return Genres[genreIndex];
	}
	async parse() {
		if (!this.tokenizer.fileInfo.size) {
			debug("Skip checking for ID3v1 because the file-size is unknown");
			return;
		}
		if (this.apeHeader) {
			this.tokenizer.ignore(this.apeHeader.offset - this.tokenizer.position);
			await new APEv2Parser(this.metadata, this.tokenizer, this.options).parseTags(this.apeHeader.footer);
		}
		const offset = this.tokenizer.fileInfo.size - Iid3v1Token.len;
		if (this.tokenizer.position > offset) {
			debug("Already consumed the last 128 bytes");
			return;
		}
		const header = await this.tokenizer.readToken(Iid3v1Token, offset);
		if (header) {
			debug("ID3v1 header found at: pos=%s", this.tokenizer.fileInfo.size - Iid3v1Token.len);
			for (const id of [
				"title",
				"artist",
				"album",
				"comment",
				"track",
				"year"
			]) if (header[id] && header[id] !== "") await this.addTag(id, header[id]);
			const genre = ID3v1Parser.getGenre(header.genre);
			if (genre) await this.addTag("genre", genre);
		} else debug("ID3v1 header not found at: pos=%s", this.tokenizer.fileInfo.size - Iid3v1Token.len);
	}
	async addTag(id, value) {
		await this.metadata.addTag("ID3v1", id, value);
	}
};
async function hasID3v1Header(tokenizer) {
	if (tokenizer.fileInfo.size >= 128) {
		const tag = new Uint8Array(3);
		const position = tokenizer.position;
		await tokenizer.readBuffer(tag, { position: tokenizer.fileInfo.size - 128 });
		tokenizer.setPosition(position);
		return textDecode(tag, "latin1") === "TAG";
	}
	return false;
}
//#endregion
export { ID3v1Parser as n, hasID3v1Header as r, Genres as t };
