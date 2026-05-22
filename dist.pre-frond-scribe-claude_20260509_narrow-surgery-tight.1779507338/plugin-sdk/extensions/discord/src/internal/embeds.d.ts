import type { APIEmbed } from "discord-api-types/v10";
export declare class Embed {
    title?: string;
    description?: string;
    url?: string;
    timestamp?: string;
    color?: number;
    footer?: APIEmbed["footer"];
    image?: string | APIEmbed["image"];
    thumbnail?: string | APIEmbed["thumbnail"];
    author?: APIEmbed["author"];
    fields?: APIEmbed["fields"];
    constructor(embed?: APIEmbed);
    serialize(): APIEmbed;
}
