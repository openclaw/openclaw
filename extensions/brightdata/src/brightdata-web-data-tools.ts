import { Type, type TSchema } from "@sinclair/typebox";
import { readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { runBrightDataWebData } from "./brightdata-client.js";

type BrightDataDatasetDefinition = {
  id: string;
  datasetId: string;
  description: string;
  inputs: string[];
  defaults?: Record<string, string>;
  fixedValues?: Record<string, string | number | boolean>;
  triggerParams?: Record<string, string | number | boolean>;
};

const DATASET_INPUT_DESCRIPTIONS: Record<string, string> = {
  url: "Target URL for the Bright Data dataset.",
  keyword: "Search keyword.",
  first_name: "First name for the search.",
  last_name: "Last name for the search.",
  num_of_reviews: "Number of reviews to fetch.",
  days_limit: "Limit results to the last N days.",
  num_of_comments: "Number of comments to fetch.",
  prompt: "Prompt to send to the AI insights dataset.",
  start_date: "Optional start date in YYYY-MM-DD format.",
  end_date: "Optional end date in YYYY-MM-DD format.",
};

export const BRIGHTDATA_DATASET_DEFINITIONS: readonly BrightDataDatasetDefinition[] = [
  {
    id: "amazon_product",
    datasetId: "gd_l7q7dkf244hwjntr0",
    description:
      "Quickly read structured amazon product data.\nRequires a valid product URL with /dp/ in it.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "amazon_product_reviews",
    datasetId: "gd_le8e811kzy4ggddlq",
    description:
      "Quickly read structured amazon product review data.\nRequires a valid product URL with /dp/ in it.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "amazon_product_search",
    datasetId: "gd_lwdb4vjm1ehb499uxs",
    description:
      "Quickly read structured amazon product search data.\nRequires a valid search keyword and amazon domain URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["keyword", "url"],
    fixedValues: {
      pages_to_search: "1",
    },
  },
  {
    id: "walmart_product",
    datasetId: "gd_l95fol7l1ru6rlo116",
    description:
      "Quickly read structured walmart product data.\nRequires a valid product URL with /ip/ in it.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "walmart_seller",
    datasetId: "gd_m7ke48w81ocyu4hhz0",
    description:
      "Quickly read structured walmart seller data.\nRequires a valid walmart seller URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "ebay_product",
    datasetId: "gd_ltr9mjt81n0zzdk1fb",
    description:
      "Quickly read structured ebay product data.\nRequires a valid ebay product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "homedepot_products",
    datasetId: "gd_lmusivh019i7g97q2n",
    description:
      "Quickly read structured homedepot product data.\nRequires a valid homedepot product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "zara_products",
    datasetId: "gd_lct4vafw1tgx27d4o0",
    description:
      "Quickly read structured zara product data.\nRequires a valid zara product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "etsy_products",
    datasetId: "gd_ltppk0jdv1jqz25mz",
    description:
      "Quickly read structured etsy product data.\nRequires a valid etsy product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "bestbuy_products",
    datasetId: "gd_ltre1jqe1jfr7cccf",
    description:
      "Quickly read structured bestbuy product data.\nRequires a valid bestbuy product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "linkedin_person_profile",
    datasetId: "gd_l1viktl72bvl7bjuj0",
    description:
      "Quickly read structured linkedin people profile data.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "linkedin_company_profile",
    datasetId: "gd_l1vikfnt1wgvvqz95w",
    description:
      "Quickly read structured linkedin company profile data\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "linkedin_job_listings",
    datasetId: "gd_lpfll7v5hcqtkxl6l",
    description:
      "Quickly read structured linkedin job listings data\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "linkedin_posts",
    datasetId: "gd_lyy3tktm25m4avu764",
    description:
      "Quickly read structured linkedin posts data.\nRequires a real LinkedIn post URL, for example:\nlinkedin.com/pulse/... or linkedin.com/posts/...\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "linkedin_people_search",
    datasetId: "gd_m8d03he47z8nwb5xc",
    description:
      "Quickly read structured linkedin people search data\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url", "first_name", "last_name"],
  },
  {
    id: "crunchbase_company",
    datasetId: "gd_l1vijqt9jfj7olije",
    description:
      "Quickly read structured crunchbase company data\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "zoominfo_company_profile",
    datasetId: "gd_m0ci4a4ivx3j5l6nx",
    description:
      "Quickly read structured ZoomInfo company profile data.\nRequires a valid ZoomInfo company URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "instagram_profiles",
    datasetId: "gd_l1vikfch901nx3by4",
    description:
      "Quickly read structured Instagram profile data.\nRequires a valid Instagram URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "instagram_posts",
    datasetId: "gd_lk5ns7kz21pck8jpis",
    description:
      "Quickly read structured Instagram post data.\nRequires a valid Instagram URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "instagram_reels",
    datasetId: "gd_lyclm20il4r5helnj",
    description:
      "Quickly read structured Instagram reel data.\nRequires a valid Instagram URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "instagram_comments",
    datasetId: "gd_ltppn085pokosxh13",
    description:
      "Quickly read structured Instagram comments data.\nRequires a valid Instagram URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "facebook_posts",
    datasetId: "gd_lyclm1571iy3mv57zw",
    description:
      "Quickly read structured Facebook post data.\nRequires a valid Facebook post URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "facebook_marketplace_listings",
    datasetId: "gd_lvt9iwuh6fbcwmx1a",
    description:
      "Quickly read structured Facebook marketplace listing data.\nRequires a valid Facebook marketplace listing URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "facebook_company_reviews",
    datasetId: "gd_m0dtqpiu1mbcyc2g86",
    description:
      "Quickly read structured Facebook company reviews data.\nRequires a valid Facebook company URL and number of reviews.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url", "num_of_reviews"],
  },
  {
    id: "facebook_events",
    datasetId: "gd_m14sd0to1jz48ppm51",
    description:
      "Quickly read structured Facebook events data.\nRequires a valid Facebook event URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "tiktok_profiles",
    datasetId: "gd_l1villgoiiidt09ci",
    description:
      "Quickly read structured Tiktok profiles data.\nRequires a valid Tiktok profile URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "tiktok_posts",
    datasetId: "gd_lu702nij2f790tmv9h",
    description:
      "Quickly read structured Tiktok post data.\nRequires a valid Tiktok post URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "tiktok_shop",
    datasetId: "gd_m45m1u911dsa4274pi",
    description:
      "Quickly read structured Tiktok shop data.\nRequires a valid Tiktok shop product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "tiktok_comments",
    datasetId: "gd_lkf2st302ap89utw5k",
    description:
      "Quickly read structured Tiktok comments data.\nRequires a valid Tiktok video URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "google_maps_reviews",
    datasetId: "gd_luzfs1dn2oa0teb81",
    description:
      "Quickly read structured Google maps reviews data.\nRequires a valid Google maps URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url", "days_limit"],
    defaults: {
      days_limit: "3",
    },
  },
  {
    id: "google_shopping",
    datasetId: "gd_ltppk50q18kdw67omz",
    description:
      "Quickly read structured Google shopping data.\nRequires a valid Google shopping product URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "google_play_store",
    datasetId: "gd_lsk382l8xei8vzm4u",
    description:
      "Quickly read structured Google play store data.\nRequires a valid Google play store app URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "apple_app_store",
    datasetId: "gd_lsk9ki3u2iishmwrui",
    description:
      "Quickly read structured apple app store data.\nRequires a valid apple app store app URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "reuter_news",
    datasetId: "gd_lyptx9h74wtlvpnfu",
    description:
      "Quickly read structured reuter news data.\nRequires a valid reuter news report URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "github_repository_file",
    datasetId: "gd_lyrexgxc24b3d4imjt",
    description:
      "Quickly read structured github repository data.\nRequires a valid github repository file URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "yahoo_finance_business",
    datasetId: "gd_lmrpz3vxmz972ghd7",
    description:
      "Quickly read structured yahoo finance business data.\nRequires a valid yahoo finance business URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "x_posts",
    datasetId: "gd_lwxkxvnf1cynvib9co",
    description:
      "Quickly read structured X post data.\nRequires a valid X post URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "x_profile_posts",
    datasetId: "gd_lwxkxvnf1cynvib9co",
    description:
      "Quickly read structured X posts from a profile.\nRequires a valid X profile URL (e.g. https://x.com/username).\nReturns the most recent posts from the profile.\nOptionally filter by date range using start_date and end_date\n(format: YYYY-MM-DD).",
    inputs: ["url", "start_date", "end_date"],
    defaults: {
      start_date: "",
      end_date: "",
    },
    triggerParams: {
      type: "discover_new",
      discover_by: "profile_url_most_recent_posts",
      limit_per_input: 10,
    },
  },
  {
    id: "zillow_properties_listing",
    datasetId: "gd_lfqkr8wm13ixtbd8f5",
    description:
      "Quickly read structured zillow properties listing data.\nRequires a valid zillow properties listing URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "booking_hotel_listings",
    datasetId: "gd_m5mbdl081229ln6t4a",
    description:
      "Quickly read structured booking hotel listings data.\nRequires a valid booking hotel listing URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "youtube_profiles",
    datasetId: "gd_lk538t2k2p1k3oos71",
    description:
      "Quickly read structured youtube profiles data.\nRequires a valid youtube profile URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "youtube_comments",
    datasetId: "gd_lk9q0ew71spt1mxywf",
    description:
      "Quickly read structured youtube comments data.\nRequires a valid youtube video URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url", "num_of_comments"],
    defaults: {
      num_of_comments: "10",
    },
  },
  {
    id: "reddit_posts",
    datasetId: "gd_lvz8ah06191smkebj4",
    description:
      "Quickly read structured reddit posts data.\nRequires a valid reddit post URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "youtube_videos",
    datasetId: "gd_lk56epmy2i5g7lzu0k",
    description:
      "Quickly read structured YouTube videos data.\nRequires a valid YouTube video URL.\nThis can be a cache lookup, so it can be more reliable than scraping",
    inputs: ["url"],
  },
  {
    id: "chatgpt_ai_insights",
    datasetId: "gd_m7aof0k82r803d5bjm",
    description:
      "Send a prompt to ChatGPT and get back AI-generated insights.\nReturns structured answer text, citations, recommendations, and markdown. Useful for GEO and LLM as a judge.",
    inputs: ["prompt"],
    fixedValues: {
      url: "https://chatgpt.com/",
      country: "",
      web_search: false,
      additional_prompt: "",
    },
    triggerParams: {
      custom_output_fields: "answer_text_markdown",
    },
  },
  {
    id: "grok_ai_insights",
    datasetId: "gd_m8ve0u141icu75ae74",
    description:
      "Send a prompt to Grok and get back AI-generated insights.\nReturns structured answer text in markdown format.\nUseful for GEO and LLM as a judge.",
    inputs: ["prompt"],
    fixedValues: {
      url: "https://grok.com/",
      index: "",
    },
    triggerParams: {
      custom_output_fields: "answer_text_markdown",
    },
  },
  {
    id: "perplexity_ai_insights",
    datasetId: "gd_m7dhdot1vw9a7gc1n",
    description:
      "Send a prompt to Perplexity and get back AI-generated insights.\nReturns structured answer text in markdown format.\nUseful for GEO and LLM as a judge.",
    inputs: ["prompt"],
    fixedValues: {
      url: "https://www.perplexity.ai",
      index: "",
      country: "",
    },
    triggerParams: {
      custom_output_fields: "answer_text_markdown",
    },
  },
];

function datasetIdToTitle(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveInputDescription(input: string): string {
  return DATASET_INPUT_DESCRIPTIONS[input] ?? `${datasetIdToTitle(input)} input.`;
}

function hasDatasetDefault(definition: BrightDataDatasetDefinition, input: string): boolean {
  return Object.prototype.hasOwnProperty.call(definition.defaults ?? {}, input);
}

function buildDatasetParameters(definition: BrightDataDatasetDefinition) {
  const properties: Record<string, TSchema> = {};
  for (const input of definition.inputs) {
    const defaultValue = definition.defaults?.[input];
    const schema = Type.String({
      description: resolveInputDescription(input),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    });
    properties[input] = defaultValue !== undefined ? Type.Optional(schema) : schema;
  }
  return Type.Object(properties, { additionalProperties: false });
}

function readDatasetInputs(
  rawParams: Record<string, unknown>,
  definition: BrightDataDatasetDefinition,
): Record<string, string> {
  const input: Record<string, string> = {};
  for (const inputName of definition.inputs) {
    const value = readStringParam(rawParams, inputName, {
      required: !hasDatasetDefault(definition, inputName),
    });
    input[inputName] = value !== undefined ? value : (definition.defaults?.[inputName] ?? "");
  }
  return input;
}

function brightDataDatasetResult(
  payload: Record<string, unknown>,
  definition: BrightDataDatasetDefinition,
) {
  const wrappedText = wrapExternalContent(JSON.stringify(payload, null, 2), {
    source: "api",
    includeWarning: true,
  });
  const externalContent = {
    untrusted: true,
    source: "api",
    provider: "brightdata",
    kind: "dataset",
    datasetId:
      typeof payload.datasetId === "string" && payload.datasetId
        ? payload.datasetId
        : definition.datasetId,
    wrapped: true,
  };
  return {
    content: [{ type: "text" as const, text: wrappedText }],
    details: {
      ...payload,
      externalContent: {
        ...(payload.externalContent && typeof payload.externalContent === "object"
          ? (payload.externalContent as Record<string, unknown>)
          : {}),
        ...externalContent,
      },
    },
  };
}

export function createBrightDataWebDataTools(api: OpenClawPluginApi) {
  return BRIGHTDATA_DATASET_DEFINITIONS.map((definition) => {
    const toolName = `brightdata_${definition.id}`;
    return {
      name: toolName,
      label: `Bright Data ${datasetIdToTitle(definition.id)}`,
      description: definition.description,
      parameters: buildDatasetParameters(definition),
      execute: async (_toolCallId: string, rawParams: Record<string, unknown>) =>
        brightDataDatasetResult(
          await runBrightDataWebData({
            cfg: api.config,
            datasetId: definition.datasetId,
            input: readDatasetInputs(rawParams, definition),
            fixedValues: definition.fixedValues,
            triggerParams: definition.triggerParams,
            toolName,
          }),
          definition,
        ),
    };
  });
}
