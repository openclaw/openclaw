import { Client } from "@notionhq/client";


export const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});


const PRODUCTS_DATABASE_ID = process.env.NOTION_PRODUCTS_DATABASE_ID || "";
const CONTACTS_DATABASE_ID = process.env.NOTION_CONTACTS_DATABASE_ID || "";
const OURSTORY_DATABASE_ID = process.env.NOTION_OURSTORY_DATABASE_ID || "";
const OURVALUE_DATABASE_ID = process.env.NOTION_OURVALUE_DATABASE_ID || "";
const OURTEAM_DATABASE_ID = process.env.NOTION_OURTEAM_DATABASE_ID || "";
const OURMISSIONVISION_DATABASE_ID = process.env.NOTION_OURMISSIONVISION_DATABASE_ID || "";
const NOTION_API_KEY = process.env.NOTION_TOKEN || "";
const NOTION_VERSION = "2022-06-28"; 

type QueryParams = {
  filter?: any;
  sorts?: Array<{ property: string; direction: "ascending" | "descending" }>;
  page_size?: number;
  start_cursor?: string;
};

async function queryDatabase(databaseId: string, params: QueryParams = {}) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion query failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { results: any[]; has_more?: boolean; next_cursor?: string };
}


const pick = {
  title: (p: any) => p?.title?.[0]?.plain_text ?? "",
  text: (p: any) => p?.rich_text?.[0]?.plain_text ?? "",
  file: (p: any) => p?.files?.[0]?.file?.url ?? p?.files?.[0]?.external?.url ?? "",
  multiFirst: (p: any) => p?.multi_select?.[0]?.name ?? "",
  multiAll: (p: any) => p.multi_select.map(({ name }) => name),
  number: (p: any) => p.number ?? 0,
};


export interface NotionProduct {
  id: string;
  en_name: string;
  zh_name: string;
  en_description: string;
  zh_description: string;
  image: string;
  en_category: string;
  zh_category: string;
  featured: boolean;
}

export interface NotionProductContent {
  id: string;
  en_name: string;
  zh_name: string;
  en_description: string;
  zh_description: string;
  image: string;
  en_category: string;
  zh_category: string;
  content_video: string;
  content_highlight1: string;
  content_highlight2: string;
  content_highlight3: string;
  content_highlight4: string;
  content_highlight5: string;
  content_highlight6: string;
  content_highlight1_description: string;
  content_highlight2_description: string;
  content_highlight3_description: string;
  content_highlight4_description: string;
  content_highlight5_description: string;
  content_highlight6_description: string;
  content_highlight1_image: string;
  content_highlight2_image: string;
  content_highlight3_image: string;
  content_highlight4_image: string;
  content_highlight5_image: string;
  content_highlight6_image: string;
  featured: boolean;
}

export interface NotionOurStory {
  id: string;
  en_title: string;
  zh_title: string;
  en_description: string;
  zh_description: string;
  image?: string;
}
export interface NotionOurValue {
  id: string;
  en_title: string;
  zh_title: string;
  en_description: string;
  zh_description: string;
  image: string;
}
export interface NotionOurTeam {
  id: string;
  en_name: string;
  zh_name: string;
  en_role: string;
  zh_role: string;
  en_role_description: string;
  zh_role_description: string;
  image?: string;
}

export interface NotionOurMissionVision {
  id: string;
  en_title: string;
  zh_title: string;
  en_description: string;
  zh_description: string;
  image: string;
}

export interface NotionContactSubmission {
  name: string;
  email: string;
  subject: string;
  message: string;
  language: string;
  timestamp: string;
}


export async function getProducts(): Promise<NotionProduct[]> {
  if (!PRODUCTS_DATABASE_ID) {
    console.warn("Notion Products Database ID not configured, returning empty");
    return [];
  }
  try {
    const data = await queryDatabase(PRODUCTS_DATABASE_ID, {
      sorts: [
        // { property: "en_category", direction: "descending" },
        { property: "created_time", direction: "descending" },
      ],
      page_size: 100,
    });

    return data.results.map((page: any) => {
      const props = page.properties || {};
      return {
        id: page.id,
        course_id: pick.number(props.course_id),
        published: !!props.published?.checkbox,
        sort_desc: pick.number(props.sort_desc),
        en_name: pick.title(props.en_name),
        zh_name: pick.text(props.zh_name),
        en_description: pick.text(props.en_description),
        zh_description: pick.text(props.zh_description),
        image: pick.file(props.image),
        en_category: pick.multiFirst(props.en_category),
        zh_category: pick.multiFirst(props.zh_category),
        featured: !!props.featured?.checkbox,
        group_price: pick.number(props.group_price),
        group_price_early: pick.number(props.group_price_early),
        single_price: pick.number(props.single_price),
        single_price_early: pick.number(props.single_price_early),
      } as NotionProduct;
    });
  } catch (error) {
    console.error("Error fetching products from Notion:", error);
    return [];
  }
}


export async function getProductById(pageId: string): Promise<NotionProductContent | null> {
  if (!pageId) {
    console.warn("Notion Products Page ID not configured, returning null");
    return null;
  }
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    console.error("getProductById failed:", await res.text());
    return null;
  }
  const page = (await res.json()) as any;
  const props = page.properties || {};
return {
        id: page.id,
        course_id: pick.number(props.course_id),
        published: !!props.published?.checkbox,
        sort_desc: pick.number(props.sort_desc),
        en_name: pick.title(props.en_name),
        zh_name: pick.text(props.zh_name),
        en_description: pick.text(props.en_description),
        zh_description: pick.text(props.zh_description),
        image: pick.file(props.image),
        en_category: pick.multiFirst(props.en_category),
        zh_category: pick.multiFirst(props.zh_category),
        featured: !!props.featured?.checkbox,
        content_video: pick.file(props.content_video),
        content_highlight1: pick.text(props.content_highlight1),
        content_highlight2: pick.text(props.content_highlight2),
        content_highlight3: pick.text(props.content_highlight3),
        content_highlight4: pick.text(props.content_highlight4),
        content_highlight5: pick.text(props.content_highlight5),
        content_highlight6: pick.text(props.content_highlight6),
        content_highlight1_description: pick.text(props.content_highlight1_description),
        content_highlight2_description: pick.text(props.content_highlight2_description),
        content_highlight3_description: pick.text(props.content_highlight3_description),
        content_highlight4_description: pick.text(props.content_highlight4_description),
        content_highlight5_description: pick.text(props.content_highlight5_description),
        content_highlight6_description: pick.text(props.content_highlight6_description),
        content_highlight1_image: pick.file(props.content_highlight1_image),
        content_highlight2_image: pick.file(props.content_highlight2_image),
        content_highlight3_image: pick.file(props.content_highlight3_image),
        content_highlight4_image: pick.file(props.content_highlight4_image),
        content_highlight5_image: pick.file(props.content_highlight5_image),
        content_highlight6_image: pick.file(props.content_highlight6_image),
        bar_text_1: pick.text(props.bar_text_1),
        bar_text_2: pick.text(props.bar_text_2),
        bar_text_3: pick.text(props.bar_text_3),
        bar_text_4: pick.text(props.bar_text_4),
        you_will_learn: pick.text(props.you_will_learn),
        skill_tags: pick.multiAll(props.skill_tags),
        content_tags: pick.multiAll(props.content_tags),
        summery: pick.text(props.summery),
        featured: !!props.featured?.checkbox,
        group_price: pick.number(props.group_price),
        group_price_early: pick.number(props.group_price_early),
        single_price: pick.number(props.single_price),
        single_price_early: pick.number(props.single_price_early),
      };
}

export async function getOurStoryContent(): Promise<NotionOurStory[]> {
  if (!OURSTORY_DATABASE_ID) {
    console.warn("Notion Our Story Database ID not configured, returning empty");
    return [];
  }
  try {
    const data = await queryDatabase(OURSTORY_DATABASE_ID, {
      sorts: [{ property: "created_time", direction: "ascending" }],
    });
    return data.results.map((page: any) => {
      const props = page.properties || {};
      return {
        id: page.id,
        en_title: pick.title(props.en_title),
        zh_title: pick.text(props.zh_title),
        en_description: pick.text(props.en_description),
        zh_description: pick.text(props.zh_description),
        image: pick.file(props.image),
      } as NotionOurStory;
    });
  } catch (error) {
    console.error("Error fetching about content (story) from Notion:", error);
    return [];
  }
}

export async function getOurValueContent(): Promise<NotionOurValue[]> {
  if (!OURVALUE_DATABASE_ID) {
    console.warn("Notion Our Value Database ID not configured, returning empty");
    return [];
  }
  try {
      const data = await queryDatabase(OURVALUE_DATABASE_ID, {
      sorts: [{ property: "created_time", direction: "ascending" }],
    });
    return data.results.map((page: any) => {
      const props = page.properties || {};
      return {
        id: page.id,
        en_title: pick.title(props.en_title),
        zh_title: pick.text(props.zh_title),
        en_description: pick.text(props.en_description),
        zh_description: pick.text(props.zh_description),
        image: pick.file(props.image),
      } as NotionOurValue;
    });
  } catch (error) {
    console.error("Error fetching about content (values) from Notion:", error);
    return [];
  }
}

export async function getOurTeamContent(): Promise<NotionOurTeam[]> {
  if (!OURTEAM_DATABASE_ID) {
    console.warn("Notion Our Team Database ID not configured, returning empty");
    return [];
  }
  try {
    const data = await queryDatabase(OURTEAM_DATABASE_ID, {
      sorts: [{ property: "created_time", direction: "ascending" }],
    });
    return data.results.map((page: any) => {
      const props = page.properties || {};
      return {
        id: page.id,
        en_name: pick.title(props.en_name),
        zh_name: pick.text(props.zh_name),
        en_role: pick.text(props.en_role),
        zh_role: pick.text(props.zh_role),
        en_role_description: pick.text(props.en_role_description),
        zh_role_description: pick.text(props.zh_role_description),
        image: pick.file(props.image),
      } as NotionOurTeam;
    });
  } catch (error) {
    console.error("Error fetching about content (team) from Notion:", error);
    return [];
  }
}

export async function getOurMissionVisionContent(): Promise<NotionOurMissionVision[]> {
  if (!OURMISSIONVISION_DATABASE_ID) {
    console.warn("Notion Our Mission Vision Database ID not configured, returning empty");
    return [];
  }
  try {
    const data = await queryDatabase(OURMISSIONVISION_DATABASE_ID, {
      sorts: [{ property: "created_time", direction: "ascending" }],
    });
    return data.results.map((page: any) => {
      const props = page.properties || {};
      return {
        id: page.id,
        en_title: pick.title(props.en_title),
        zh_title: pick.text(props.zh_title),
        en_description: pick.text(props.en_description),
        zh_description: pick.text(props.zh_description),
        image: pick.file(props.image),
      } as NotionOurValue;
    });
  } catch (error) {
    console.error("Error fetching about content (values) from Notion:", error);
    return [];
  }
}


export async function submitContactForm(data: NotionContactSubmission): Promise<boolean> {
  try {
    await notion.pages.create({
      parent: { database_id: CONTACTS_DATABASE_ID },
      properties: {
        name: { title: [{ text: { content: data.name } }] },
        email: { rich_text: [{ text: { content: data.email } }] },
        subject: { select: { name: data.subject } },
        message: { rich_text: [{ text: { content: data.message } }] },
        language: { select: { name: data.language } },
        submitted_at: { date: { start: data.timestamp } },
        status: { select: { name: "New" } },
      },
    });
    return true;
  } catch (error) {
    console.error("Error submitting contact form to Notion:", error);
    return false;
  }
}


