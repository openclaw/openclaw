/**
 * Marketing Tools — Social media management, ad campaigns, content publishing
 *
 * Platforms: Meta (Facebook/Instagram/WhatsApp), Pinterest, LinkedIn, TikTok
 * Capabilities: Post publishing, ad campaign management, audience targeting, analytics
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// --- HTTP Helper ---
async function apiCall(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: any,
): Promise<{ status: number; data: any }> {
  try {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (body && method !== "GET") opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(async () => ({ raw: await resp.text() }));
    return { status: resp.status, data };
  } catch (err) {
    return { status: 0, data: { error: String(err) } };
  }
}

// --- Platform configs ---
type PlatformConfig = {
  platform: string;
  access_token: string;
  account_id?: string; // Ad account ID
  page_id?: string; // Facebook page ID
  business_id?: string; // Business manager ID
  pixel_id?: string;
  app_id?: string;
  app_secret?: string;
  extra?: Record<string, string>;
};

function marketingPath(api: OpenClawPluginApi, bizId: string) {
  return join(resolveWorkspaceDir(api), "businesses", bizId, "marketing.json");
}

async function loadMarketing(api: OpenClawPluginApi, bizId: string) {
  return (
    (await readJson(marketingPath(api, bizId))) || {
      platforms: {},
      campaigns: [],
      posts: [],
      analytics: [],
    }
  );
}

async function saveMarketing(api: OpenClawPluginApi, bizId: string, data: any) {
  await writeJson(marketingPath(api, bizId), data);
}

// ============================================================================
// Parameter Schemas
// ============================================================================

const PlatformConnectParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  platform: Type.Union(
    [
      Type.Literal("meta"),
      Type.Literal("instagram"),
      Type.Literal("whatsapp"),
      Type.Literal("pinterest"),
      Type.Literal("linkedin"),
      Type.Literal("tiktok"),
    ],
    { description: "Platform to connect" },
  ),
  access_token: Type.String({ description: "Platform access token / API key" }),
  account_id: Type.Optional(
    Type.String({
      description:
        "Ad account ID (Meta: act_xxxxx, LinkedIn: sponsor account, TikTok: advertiser ID)",
    }),
  ),
  page_id: Type.Optional(
    Type.String({ description: "Page/profile ID (Facebook page, LinkedIn company, etc.)" }),
  ),
  business_id_platform: Type.Optional(
    Type.String({ description: "Business manager / organization ID" }),
  ),
  pixel_id: Type.Optional(
    Type.String({ description: "Tracking pixel ID (Meta Pixel, TikTok Pixel)" }),
  ),
  app_id: Type.Optional(Type.String({ description: "App ID (for Meta, TikTok)" })),
  app_secret: Type.Optional(Type.String({ description: "App secret" })),
  extra: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Platform-specific config" }),
  ),
});

const ContentPublishParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  platforms: Type.Array(
    Type.Union([
      Type.Literal("facebook"),
      Type.Literal("instagram"),
      Type.Literal("linkedin"),
      Type.Literal("pinterest"),
      Type.Literal("tiktok"),
    ]),
    { description: "Platforms to publish to" },
  ),
  content_type: Type.Union(
    [
      Type.Literal("text"),
      Type.Literal("image"),
      Type.Literal("video"),
      Type.Literal("carousel"),
      Type.Literal("story"),
      Type.Literal("reel"),
      Type.Literal("pin"),
    ],
    { description: "Content type" },
  ),
  text: Type.Optional(Type.String({ description: "Post text / caption" })),
  media_url: Type.Optional(Type.String({ description: "Media URL (image or video)" })),
  media_urls: Type.Optional(
    Type.Array(Type.String(), { description: "Multiple media URLs (carousel)" }),
  ),
  link: Type.Optional(Type.String({ description: "Link to include" })),
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Hashtags" })),
  schedule_at: Type.Optional(
    Type.String({ description: "Schedule publish time (ISO date, omit for immediate)" }),
  ),
  // Platform-specific
  pinterest_board_id: Type.Optional(Type.String({ description: "Pinterest board ID" })),
  linkedin_visibility: Type.Optional(
    Type.Union([Type.Literal("PUBLIC"), Type.Literal("CONNECTIONS")]),
  ),
  instagram_location_id: Type.Optional(Type.String()),
  tiktok_privacy: Type.Optional(
    Type.Union([Type.Literal("PUBLIC"), Type.Literal("FRIENDS"), Type.Literal("PRIVATE")]),
  ),
});

const AdCampaignCreateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  platform: Type.Union(
    [
      Type.Literal("meta"),
      Type.Literal("pinterest"),
      Type.Literal("linkedin"),
      Type.Literal("tiktok"),
    ],
    { description: "Ad platform" },
  ),
  campaign_name: Type.String({ description: "Campaign name" }),
  objective: Type.Union(
    [
      Type.Literal("awareness"),
      Type.Literal("traffic"),
      Type.Literal("engagement"),
      Type.Literal("leads"),
      Type.Literal("sales"),
      Type.Literal("app_installs"),
      Type.Literal("video_views"),
      Type.Literal("conversions"),
    ],
    { description: "Campaign objective" },
  ),
  daily_budget_usd: Type.Number({ description: "Daily budget in USD" }),
  total_budget_usd: Type.Optional(Type.Number({ description: "Total lifetime budget (optional)" })),
  start_date: Type.String({ description: "Campaign start date (ISO)" }),
  end_date: Type.Optional(
    Type.String({ description: "Campaign end date (ISO, omit for ongoing)" }),
  ),
  targeting: Type.Object(
    {
      locations: Type.Optional(
        Type.Array(Type.String(), { description: "Target locations (countries/cities)" }),
      ),
      age_min: Type.Optional(Type.Number({ description: "Min age" })),
      age_max: Type.Optional(Type.Number({ description: "Max age" })),
      genders: Type.Optional(
        Type.Array(Type.Union([Type.Literal("male"), Type.Literal("female"), Type.Literal("all")])),
      ),
      interests: Type.Optional(
        Type.Array(Type.String(), { description: "Interest targeting keywords" }),
      ),
      custom_audiences: Type.Optional(
        Type.Array(Type.String(), { description: "Custom audience IDs" }),
      ),
      lookalike_audiences: Type.Optional(
        Type.Array(Type.String(), { description: "Lookalike audience IDs" }),
      ),
      placements: Type.Optional(
        Type.Array(Type.String(), { description: "Ad placements (feed, stories, reels, etc.)" }),
      ),
    },
    { description: "Audience targeting" },
  ),
  creatives: Type.Array(
    Type.Object({
      headline: Type.Optional(Type.String()),
      text: Type.String({ description: "Ad copy" }),
      media_url: Type.Optional(Type.String({ description: "Creative media URL" })),
      call_to_action: Type.Optional(
        Type.String({ description: "CTA (shop_now, learn_more, sign_up, etc.)" }),
      ),
      landing_url: Type.Optional(Type.String({ description: "Landing page URL" })),
    }),
    { description: "Ad creatives" },
  ),
});

const AdCampaignManageParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  platform: Type.Union([
    Type.Literal("meta"),
    Type.Literal("pinterest"),
    Type.Literal("linkedin"),
    Type.Literal("tiktok"),
  ]),
  campaign_id: Type.String({ description: "Campaign ID" }),
  action: Type.Union(
    [
      Type.Literal("pause"),
      Type.Literal("resume"),
      Type.Literal("update_budget"),
      Type.Literal("update_targeting"),
      Type.Literal("stop"),
      Type.Literal("duplicate"),
    ],
    { description: "Action to take" },
  ),
  new_budget: Type.Optional(Type.Number({ description: "New daily budget (for update_budget)" })),
  new_targeting: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Updated targeting (for update_targeting)",
    }),
  ),
});

const AdAnalyticsParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  platform: Type.Optional(
    Type.Union(
      [
        Type.Literal("meta"),
        Type.Literal("pinterest"),
        Type.Literal("linkedin"),
        Type.Literal("tiktok"),
        Type.Literal("all"),
      ],
      { description: "Platform filter (default: all)" },
    ),
  ),
  campaign_id: Type.Optional(Type.String({ description: "Specific campaign ID" })),
  date_from: Type.Optional(Type.String({ description: "Start date (ISO)" })),
  date_to: Type.Optional(Type.String({ description: "End date (ISO)" })),
  metrics: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Specific metrics to fetch (impressions, clicks, cpc, cpm, roas, conversions, spend)",
    }),
  ),
});

const AudienceCreateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  platform: Type.Union([
    Type.Literal("meta"),
    Type.Literal("pinterest"),
    Type.Literal("linkedin"),
    Type.Literal("tiktok"),
  ]),
  audience_name: Type.String({ description: "Audience name" }),
  audience_type: Type.Union(
    [
      Type.Literal("custom"),
      Type.Literal("lookalike"),
      Type.Literal("saved"),
      Type.Literal("website_visitors"),
      Type.Literal("customer_list"),
      Type.Literal("engagement"),
    ],
    { description: "Audience type" },
  ),
  source: Type.Optional(
    Type.String({ description: "Source for lookalike/custom (pixel, page, customer list path)" }),
  ),
  lookalike_percentage: Type.Optional(Type.Number({ description: "Lookalike expansion % (1-10)" })),
  retention_days: Type.Optional(
    Type.Number({ description: "Website visitor retention window (days)" }),
  ),
  description: Type.Optional(Type.String()),
});

const WhatsAppMessageParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  template_name: Type.Optional(
    Type.String({ description: "WhatsApp message template name (for business-initiated)" }),
  ),
  to: Type.String({ description: "Recipient phone number (E.164 format)" }),
  message_type: Type.Union(
    [
      Type.Literal("template"),
      Type.Literal("text"),
      Type.Literal("image"),
      Type.Literal("document"),
      Type.Literal("interactive"),
    ],
    { description: "Message type" },
  ),
  text: Type.Optional(Type.String({ description: "Message text" })),
  media_url: Type.Optional(Type.String({ description: "Media URL for image/document" })),
  template_params: Type.Optional(
    Type.Array(Type.String(), { description: "Template parameter values" }),
  ),
  buttons: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Union([Type.Literal("reply"), Type.Literal("url")]),
        text: Type.String(),
        url: Type.Optional(Type.String()),
      }),
      { description: "Interactive buttons" },
    ),
  ),
});

const ContentCalendarParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([Type.Literal("view"), Type.Literal("add"), Type.Literal("remove")]),
  entry: Type.Optional(
    Type.Object({
      date: Type.String({ description: "Publish date (ISO)" }),
      platforms: Type.Array(Type.String()),
      content_type: Type.String(),
      topic: Type.String({ description: "Content topic/brief" }),
      status: Type.Optional(
        Type.Union([
          Type.Literal("planned"),
          Type.Literal("drafted"),
          Type.Literal("approved"),
          Type.Literal("published"),
        ]),
      ),
      assigned_to: Type.Optional(Type.String({ description: "Contractor or agent responsible" })),
    }),
  ),
  date_from: Type.Optional(Type.String()),
  date_to: Type.Optional(Type.String()),
});

// ============================================================================
// Platform API Implementations
// ============================================================================

const PLATFORM_APIS: Record<string, { base: string; version: string }> = {
  meta: { base: "https://graph.facebook.com", version: "v21.0" },
  instagram: { base: "https://graph.facebook.com", version: "v21.0" },
  whatsapp: { base: "https://graph.facebook.com", version: "v21.0" },
  pinterest: { base: "https://api.pinterest.com", version: "v5" },
  linkedin: { base: "https://api.linkedin.com", version: "v2" },
  tiktok: { base: "https://business-api.tiktok.com/open_api", version: "v1.3" },
};

function platformHeaders(config: PlatformConfig): Record<string, string> {
  if (config.platform === "linkedin") {
    return { Authorization: `Bearer ${config.access_token}`, "X-Restli-Protocol-Version": "2.0.0" };
  }
  if (config.platform === "tiktok") {
    return { "Access-Token": config.access_token };
  }
  return { Authorization: `Bearer ${config.access_token}` };
}

function metaUrl(path: string) {
  return `${PLATFORM_APIS.meta.base}/${PLATFORM_APIS.meta.version}${path}`;
}
function pinterestUrl(path: string) {
  return `${PLATFORM_APIS.pinterest.base}/${PLATFORM_APIS.pinterest.version}${path}`;
}
function linkedinUrl(path: string) {
  return `${PLATFORM_APIS.linkedin.base}/${PLATFORM_APIS.linkedin.version}${path}`;
}
function tiktokUrl(path: string) {
  return `${PLATFORM_APIS.tiktok.base}/${PLATFORM_APIS.tiktok.version}${path}`;
}

// ============================================================================
// Tool Implementations
// ============================================================================

export function createMarketingTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    // --- Platform Connection ---
    {
      name: "marketing_connect",
      label: "Connect Marketing Platform",
      description:
        "Connect a social media / ad platform (Meta, Instagram, WhatsApp, Pinterest, LinkedIn, TikTok) with API credentials.",
      parameters: PlatformConnectParams,
      async execute(_id: string, params: Static<typeof PlatformConnectParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        mkt.platforms[params.platform] = {
          platform: params.platform,
          access_token: params.access_token,
          account_id: params.account_id,
          page_id: params.page_id,
          business_id: params.business_id_platform,
          pixel_id: params.pixel_id,
          app_id: params.app_id,
          app_secret: params.app_secret,
          extra: params.extra,
          connected_at: new Date().toISOString(),
        };
        await saveMarketing(api, params.business_id, mkt);

        // Test connection
        let testResult = "not tested";
        const config = mkt.platforms[params.platform];
        const headers = platformHeaders(config);

        if (params.platform === "meta" || params.platform === "instagram") {
          const r = await apiCall(metaUrl("/me"), "GET", headers);
          testResult =
            r.status === 200
              ? `✅ Connected as: ${r.data.name || r.data.id}`
              : `❌ Error: ${r.data.error?.message || r.status}`;
        } else if (params.platform === "linkedin") {
          const r = await apiCall(linkedinUrl("/me"), "GET", headers);
          testResult = r.status === 200 ? `✅ Connected` : `❌ Error: ${r.status}`;
        } else if (params.platform === "pinterest") {
          const r = await apiCall(pinterestUrl("/user_account"), "GET", headers);
          testResult =
            r.status === 200
              ? `✅ Connected as: ${r.data.username || "OK"}`
              : `❌ Error: ${r.status}`;
        } else if (params.platform === "tiktok") {
          const r = await apiCall(tiktokUrl("/advertiser/info/"), "GET", headers);
          testResult =
            r.status === 200 || r.data?.code === 0
              ? "✅ Connected"
              : `❌ Error: ${r.data?.message || r.status}`;
        }

        return textResult(`Platform ${params.platform} connected for ${params.business_id}.
- Account ID: ${params.account_id || "not set"}
- Page ID: ${params.page_id || "not set"}
- Pixel: ${params.pixel_id || "not set"}
- Connection test: ${testResult}`);
      },
    },

    // --- Content Publishing ---
    {
      name: "content_publish",
      label: "Publish Content",
      description:
        "Publish content to one or more social platforms (Facebook, Instagram, LinkedIn, Pinterest, TikTok). Supports text, image, video, carousel, stories, reels, and pins.",
      parameters: ContentPublishParams,
      async execute(_id: string, params: Static<typeof ContentPublishParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        const now = new Date().toISOString();
        const results: string[] = [];
        const fullText = [
          params.text,
          ...(params.hashtags || []).map((h) => (h.startsWith("#") ? h : `#${h}`)),
        ]
          .filter(Boolean)
          .join("\n");

        for (const platform of params.platforms) {
          const platKey = platform === "facebook" || platform === "instagram" ? "meta" : platform;
          const config = mkt.platforms[platKey] || mkt.platforms[platform];
          if (!config) {
            results.push(`❌ ${platform}: Not connected. Use \`marketing_connect\` first.`);
            continue;
          }

          const headers = platformHeaders(config);

          if (platform === "facebook") {
            const pageId = config.page_id;
            if (!pageId) {
              results.push("❌ Facebook: No page_id configured.");
              continue;
            }

            if (params.content_type === "text" || params.content_type === "image") {
              const endpoint = params.media_url
                ? metaUrl(`/${pageId}/photos`)
                : metaUrl(`/${pageId}/feed`);
              const body: any = { message: fullText };
              if (params.media_url) body.url = params.media_url;
              if (params.link) body.link = params.link;
              if (params.schedule_at) {
                body.published = false;
                body.scheduled_publish_time = Math.floor(
                  new Date(params.schedule_at).getTime() / 1000,
                );
              }
              const r = await apiCall(endpoint, "POST", headers, body);
              results.push(
                r.status === 200
                  ? `✅ Facebook: Published (ID: ${r.data.id || r.data.post_id})`
                  : `❌ Facebook: ${r.data.error?.message || r.status}`,
              );
            } else if (params.content_type === "video") {
              const r = await apiCall(metaUrl(`/${pageId}/videos`), "POST", headers, {
                description: fullText,
                file_url: params.media_url,
              });
              results.push(
                r.status === 200
                  ? `✅ Facebook video: ${r.data.id}`
                  : `❌ Facebook video: ${r.data.error?.message || r.status}`,
              );
            }
          }

          if (platform === "instagram") {
            const igId = config.extra?.instagram_account_id || config.page_id;
            if (!igId) {
              results.push("❌ Instagram: No account ID configured.");
              continue;
            }

            if (
              params.content_type === "image" ||
              params.content_type === "reel" ||
              params.content_type === "carousel"
            ) {
              // Step 1: Create media container
              const containerBody: any = { caption: fullText };
              if (params.content_type === "image") {
                containerBody.image_url = params.media_url;
              } else if (params.content_type === "reel") {
                containerBody.media_type = "REELS";
                containerBody.video_url = params.media_url;
              } else if (params.content_type === "carousel") {
                // Create children first
                const children: string[] = [];
                for (const url of params.media_urls || []) {
                  const isVideo = url.match(/\.(mp4|mov|avi)/i);
                  const childBody: any = isVideo
                    ? { media_type: "VIDEO", video_url: url }
                    : { image_url: url };
                  const cr = await apiCall(metaUrl(`/${igId}/media`), "POST", headers, childBody);
                  if (cr.data?.id) children.push(cr.data.id);
                }
                containerBody.media_type = "CAROUSEL";
                containerBody.children = children.join(",");
              }

              const container = await apiCall(
                metaUrl(`/${igId}/media`),
                "POST",
                headers,
                containerBody,
              );
              if (container.data?.id) {
                // Step 2: Publish
                const pub = await apiCall(metaUrl(`/${igId}/media_publish`), "POST", headers, {
                  creation_id: container.data.id,
                });
                results.push(
                  pub.status === 200
                    ? `✅ Instagram ${params.content_type}: ${pub.data.id}`
                    : `❌ Instagram publish: ${pub.data.error?.message}`,
                );
              } else {
                results.push(
                  `❌ Instagram container: ${container.data?.error?.message || container.status}`,
                );
              }
            }
          }

          if (platform === "linkedin") {
            const orgId = config.page_id; // LinkedIn company/organization ID
            const body: any = {
              author: orgId ? `urn:li:organization:${orgId}` : "urn:li:person:me",
              lifecycleState: "PUBLISHED",
              specificContent: {
                "com.linkedin.ugc.ShareContent": {
                  shareCommentary: { text: fullText },
                  shareMediaCategory: params.media_url ? "IMAGE" : "NONE",
                  ...(params.media_url
                    ? {
                        media: [{ status: "READY", originalUrl: params.media_url }],
                      }
                    : {}),
                },
              },
              visibility: {
                "com.linkedin.ugc.MemberNetworkVisibility": params.linkedin_visibility || "PUBLIC",
              },
            };
            const r = await apiCall(linkedinUrl("/ugcPosts"), "POST", headers, body);
            results.push(
              r.status === 201
                ? `✅ LinkedIn: Published (${r.data.id || "OK"})`
                : `❌ LinkedIn: ${r.data?.message || r.status}`,
            );
          }

          if (platform === "pinterest") {
            if (!config.extra?.board_id && !params.pinterest_board_id) {
              results.push("❌ Pinterest: No board_id specified.");
              continue;
            }
            const body: any = {
              board_id: params.pinterest_board_id || config.extra?.board_id,
              title: params.text?.slice(0, 100) || "",
              description: fullText,
              link: params.link,
              media_source: params.media_url
                ? { source_type: "image_url", url: params.media_url }
                : undefined,
            };
            const r = await apiCall(pinterestUrl("/pins"), "POST", headers, body);
            results.push(
              r.status === 201
                ? `✅ Pinterest pin: ${r.data.id}`
                : `❌ Pinterest: ${r.data?.message || r.status}`,
            );
          }

          if (platform === "tiktok") {
            // TikTok Content Posting API
            const body: any = {
              post_info: {
                title: params.text?.slice(0, 150) || "",
                privacy_level: params.tiktok_privacy || "PUBLIC_TO_EVERYONE",
              },
              source_info: {
                source: "PULL_FROM_URL",
                video_url: params.media_url,
              },
            };
            const r = await apiCall(tiktokUrl("/post/publish/video/init/"), "POST", headers, body);
            results.push(
              r.data?.error?.code === "ok" || r.status === 200
                ? `✅ TikTok: Upload initiated (${r.data?.data?.publish_id || "OK"})`
                : `❌ TikTok: ${r.data?.error?.message || r.status}`,
            );
          }
        }

        // Log the post
        mkt.posts.push({
          id: `POST-${Date.now().toString(36)}`,
          platforms: params.platforms,
          content_type: params.content_type,
          text: params.text,
          media_url: params.media_url,
          scheduled: params.schedule_at,
          results,
          created_at: now,
        });
        await saveMarketing(api, params.business_id, mkt);

        return textResult(`## Content Published\n\n${results.join("\n")}`);
      },
    },

    // --- Ad Campaign Creation ---
    {
      name: "ad_campaign_create",
      label: "Create Ad Campaign",
      description:
        "Create an advertising campaign on Meta, Pinterest, LinkedIn, or TikTok with targeting, budget, and creatives.",
      parameters: AdCampaignCreateParams,
      async execute(_id: string, params: Static<typeof AdCampaignCreateParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        const config = mkt.platforms[params.platform];
        if (!config)
          return textResult(
            `❌ ${params.platform} not connected. Use \`marketing_connect\` first.`,
          );

        const headers = platformHeaders(config);
        const now = new Date().toISOString();
        let campaignResult: any = {};

        // Governance check — ad spend
        const stakeholder =
          (await readJson(join(resolveWorkspaceDir(api), "stakeholder.json"))) || {};
        const totalBudget = params.total_budget_usd || params.daily_budget_usd * 30;
        if (totalBudget > (stakeholder.approval_threshold_usd || 5000)) {
          return textResult(`⚠️ Campaign budget ($${totalBudget}) exceeds approval threshold ($${stakeholder.approval_threshold_usd || 5000}).
Use \`decision_request\` to get stakeholder approval before creating this campaign.`);
        }

        const objectiveMap: Record<string, Record<string, string>> = {
          meta: {
            awareness: "OUTCOME_AWARENESS",
            traffic: "OUTCOME_TRAFFIC",
            engagement: "OUTCOME_ENGAGEMENT",
            leads: "OUTCOME_LEADS",
            sales: "OUTCOME_SALES",
            app_installs: "OUTCOME_APP_PROMOTION",
            conversions: "OUTCOME_SALES",
          },
          pinterest: {
            awareness: "AWARENESS",
            traffic: "CONSIDERATION",
            engagement: "CONSIDERATION",
            leads: "CONSIDERATION",
            sales: "CONVERSIONS",
            video_views: "VIDEO_VIEW",
          },
          linkedin: {
            awareness: "BRAND_AWARENESS",
            traffic: "WEBSITE_VISITS",
            engagement: "ENGAGEMENT",
            leads: "LEAD_GENERATION",
            conversions: "WEBSITE_CONVERSIONS",
          },
          tiktok: {
            awareness: "REACH",
            traffic: "TRAFFIC",
            engagement: "ENGAGEMENT",
            leads: "LEAD_GENERATION",
            sales: "CONVERSIONS",
            app_installs: "APP_INSTALL",
            video_views: "VIDEO_VIEWS",
            conversions: "CONVERSIONS",
          },
        };

        if (params.platform === "meta") {
          const adAccountId = config.account_id;
          if (!adAccountId) return textResult("❌ Meta: No ad account ID configured.");

          // 1. Create campaign
          const campaignBody = {
            name: params.campaign_name,
            objective: objectiveMap.meta[params.objective] || "OUTCOME_TRAFFIC",
            status: "PAUSED",
            special_ad_categories: [],
          };
          const camp = await apiCall(
            metaUrl(`/${adAccountId}/campaigns`),
            "POST",
            headers,
            campaignBody,
          );
          if (!camp.data?.id)
            return textResult(
              `❌ Meta campaign creation failed: ${camp.data?.error?.message || camp.status}`,
            );

          // 2. Create ad set
          const adSetBody: any = {
            name: `${params.campaign_name} - Ad Set`,
            campaign_id: camp.data.id,
            daily_budget: Math.round(params.daily_budget_usd * 100),
            billing_event: "IMPRESSIONS",
            optimization_goal: "LINK_CLICKS",
            start_time: params.start_date,
            end_time: params.end_date,
            targeting: {
              geo_locations: params.targeting.locations?.length
                ? { countries: params.targeting.locations }
                : { countries: ["US"] },
              age_min: params.targeting.age_min || 18,
              age_max: params.targeting.age_max || 65,
              ...(params.targeting.interests?.length
                ? {
                    flexible_spec: [
                      { interests: params.targeting.interests.map((i) => ({ name: i })) },
                    ],
                  }
                : {}),
            },
            status: "PAUSED",
          };
          if (params.targeting.placements?.length) {
            adSetBody.targeting.publisher_platforms = params.targeting.placements;
          }
          const adSet = await apiCall(
            metaUrl(`/${adAccountId}/adsets`),
            "POST",
            headers,
            adSetBody,
          );

          // 3. Create ads from creatives
          const adResults: string[] = [];
          for (const creative of params.creatives) {
            const adCreativeBody = {
              name: creative.headline || `${params.campaign_name} creative`,
              object_story_spec: {
                page_id: config.page_id,
                link_data: {
                  message: creative.text,
                  link: creative.landing_url,
                  name: creative.headline,
                  call_to_action: creative.call_to_action
                    ? { type: creative.call_to_action.toUpperCase() }
                    : undefined,
                  image_url: creative.media_url,
                },
              },
            };
            const cr = await apiCall(
              metaUrl(`/${adAccountId}/adcreatives`),
              "POST",
              headers,
              adCreativeBody,
            );
            if (cr.data?.id && adSet.data?.id) {
              const ad = await apiCall(metaUrl(`/${adAccountId}/ads`), "POST", headers, {
                name: creative.headline || params.campaign_name,
                adset_id: adSet.data.id,
                creative: { creative_id: cr.data.id },
                status: "PAUSED",
              });
              adResults.push(ad.data?.id ? `✅ Ad: ${ad.data.id}` : `❌ Ad failed`);
            }
          }

          campaignResult = {
            campaign_id: camp.data.id,
            adset_id: adSet.data?.id,
            ads: adResults,
            status: "PAUSED (activate when ready)",
          };
        } else {
          // For other platforms, store locally and provide API instructions
          const localCampaign = {
            id: `CAMP-${Date.now().toString(36)}`,
            platform: params.platform,
            name: params.campaign_name,
            objective: params.objective,
            daily_budget_usd: params.daily_budget_usd,
            total_budget_usd: params.total_budget_usd,
            start_date: params.start_date,
            end_date: params.end_date,
            targeting: params.targeting,
            creatives: params.creatives,
            status: "draft",
            created_at: now,
          };
          mkt.campaigns.push(localCampaign);
          await saveMarketing(api, params.business_id, mkt);

          campaignResult = {
            campaign_id: localCampaign.id,
            platform: params.platform,
            status: "draft (use integration_call to push to platform API)",
            api_endpoint:
              params.platform === "pinterest"
                ? pinterestUrl("/ad_accounts/{ad_account_id}/campaigns")
                : params.platform === "linkedin"
                  ? linkedinUrl("/adCampaignsV2")
                  : params.platform === "tiktok"
                    ? tiktokUrl("/campaign/create/")
                    : "unknown",
          };
        }

        return textResult(`## Ad Campaign Created

**Name:** ${params.campaign_name}
**Platform:** ${params.platform}
**Objective:** ${params.objective}
**Budget:** $${params.daily_budget_usd}/day${params.total_budget_usd ? ` ($${params.total_budget_usd} lifetime)` : ""}
**Dates:** ${params.start_date}${params.end_date ? ` → ${params.end_date}` : " (ongoing)"}
**Creatives:** ${params.creatives.length}

**Targeting:**
- Locations: ${params.targeting.locations?.join(", ") || "default"}
- Age: ${params.targeting.age_min || 18}–${params.targeting.age_max || 65}
- Interests: ${params.targeting.interests?.join(", ") || "broad"}

**Result:**
\`\`\`json
${JSON.stringify(campaignResult, null, 2)}
\`\`\``);
      },
    },

    // --- Campaign Management ---
    {
      name: "ad_campaign_manage",
      label: "Manage Ad Campaign",
      description: "Pause, resume, update budget/targeting, stop, or duplicate an ad campaign.",
      parameters: AdCampaignManageParams,
      async execute(_id: string, params: Static<typeof AdCampaignManageParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        const config = mkt.platforms[params.platform];
        if (!config) return textResult(`❌ ${params.platform} not connected.`);

        const headers = platformHeaders(config);

        if (params.platform === "meta") {
          const statusMap: Record<string, string> = {
            pause: "PAUSED",
            resume: "ACTIVE",
            stop: "DELETED",
          };

          if (params.action === "pause" || params.action === "resume" || params.action === "stop") {
            const r = await apiCall(metaUrl(`/${params.campaign_id}`), "POST", headers, {
              status: statusMap[params.action],
            });
            return textResult(
              `Campaign ${params.campaign_id} → ${params.action}: ${r.status === 200 ? "✅ Done" : `❌ ${r.data?.error?.message || r.status}`}`,
            );
          }

          if (params.action === "update_budget" && params.new_budget) {
            // Update all ad sets in this campaign
            const adsets = await apiCall(
              metaUrl(`/${params.campaign_id}/adsets?fields=id`),
              "GET",
              headers,
            );
            const results: string[] = [];
            for (const as of adsets.data?.data || []) {
              const r = await apiCall(metaUrl(`/${as.id}`), "POST", headers, {
                daily_budget: Math.round(params.new_budget * 100),
              });
              results.push(r.status === 200 ? `✅ ${as.id}` : `❌ ${as.id}`);
            }
            return textResult(
              `Budget updated to $${params.new_budget}/day:\n${results.join("\n")}`,
            );
          }
        }

        // Local campaign management
        const localCamp = mkt.campaigns.find((c: any) => c.id === params.campaign_id);
        if (localCamp) {
          if (params.action === "pause") localCamp.status = "paused";
          else if (params.action === "resume") localCamp.status = "active";
          else if (params.action === "stop") localCamp.status = "stopped";
          else if (params.action === "update_budget" && params.new_budget)
            localCamp.daily_budget_usd = params.new_budget;
          else if (params.action === "update_targeting" && params.new_targeting)
            Object.assign(localCamp.targeting, params.new_targeting);
          else if (params.action === "duplicate") {
            const dup = {
              ...localCamp,
              id: `CAMP-${Date.now().toString(36)}`,
              name: `${localCamp.name} (copy)`,
              status: "draft",
            };
            mkt.campaigns.push(dup);
          }
          await saveMarketing(api, params.business_id, mkt);
          return textResult(`Campaign ${params.campaign_id} → ${params.action}: ✅ Done`);
        }

        return textResult(`Campaign ${params.campaign_id} not found.`);
      },
    },

    // --- Analytics ---
    {
      name: "ad_analytics",
      label: "Ad Analytics",
      description:
        "Fetch ad performance metrics — impressions, clicks, CPC, CPM, ROAS, conversions, spend.",
      parameters: AdAnalyticsParams,
      async execute(_id: string, params: Static<typeof AdAnalyticsParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        const platform = params.platform || "all";
        const results: string[] = [];

        const fetchMetrics = async (plat: string) => {
          const config = mkt.platforms[plat];
          if (!config) return `❌ ${plat}: Not connected.`;
          const headers = platformHeaders(config);

          if (plat === "meta" && config.account_id) {
            const fields = "impressions,clicks,spend,cpc,cpm,actions,cost_per_action_type";
            let url = params.campaign_id
              ? metaUrl(`/${params.campaign_id}/insights?fields=${fields}`)
              : metaUrl(`/${config.account_id}/insights?fields=${fields}&level=campaign`);
            if (params.date_from)
              url += `&time_range={"since":"${params.date_from}","until":"${params.date_to || new Date().toISOString().split("T")[0]}"}`;

            const r = await apiCall(url, "GET", headers);
            if (r.data?.data?.length) {
              return r.data.data
                .map(
                  (d: any) =>
                    `**${d.campaign_name || "Campaign"}**\n  Impressions: ${d.impressions} | Clicks: ${d.clicks} | Spend: $${d.spend} | CPC: $${d.cpc} | CPM: $${d.cpm}`,
                )
                .join("\n");
            }
            return r.data?.error ? `❌ Meta: ${r.data.error.message}` : "No data for this period.";
          }

          if (plat === "pinterest" && config.account_id) {
            const r = await apiCall(
              pinterestUrl(
                `/ad_accounts/${config.account_id}/analytics?start_date=${params.date_from || "2026-01-01"}&end_date=${params.date_to || new Date().toISOString().split("T")[0]}&columns=SPEND_IN_DOLLAR,IMPRESSION,CLICKTHROUGH,CPC_IN_DOLLAR,CTR&granularity=TOTAL`,
              ),
              "GET",
              headers,
            );
            return r.status === 200
              ? `Pinterest: ${JSON.stringify(r.data, null, 2).slice(0, 500)}`
              : `❌ Pinterest: ${r.status}`;
          }

          if (plat === "tiktok" && config.account_id) {
            const r = await apiCall(
              tiktokUrl(
                `/report/integrated/get/?advertiser_id=${config.account_id}&report_type=BASIC&dimensions=["campaign_id"]&metrics=["spend","impressions","clicks","cpc","cpm","conversions"]`,
              ),
              "GET",
              headers,
            );
            return r.data?.code === 0
              ? `TikTok: ${JSON.stringify(r.data.data, null, 2).slice(0, 500)}`
              : `❌ TikTok: ${r.data?.message || r.status}`;
          }

          return `${plat}: Use integration_call for detailed analytics.`;
        };

        if (platform === "all") {
          for (const plat of Object.keys(mkt.platforms)) {
            results.push(
              `### ${plat.charAt(0).toUpperCase() + plat.slice(1)}\n${await fetchMetrics(plat)}`,
            );
          }
        } else {
          results.push(await fetchMetrics(platform));
        }

        return textResult(
          `## 📊 Ad Analytics — ${params.business_id}\n${params.date_from ? `**Period:** ${params.date_from} → ${params.date_to || "now"}` : ""}\n\n${results.join("\n\n")}`,
        );
      },
    },

    // --- Audience Management ---
    {
      name: "audience_create",
      label: "Create Audience",
      description: "Create a custom, lookalike, or saved audience for ad targeting.",
      parameters: AudienceCreateParams,
      async execute(_id: string, params: Static<typeof AudienceCreateParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        const config = mkt.platforms[params.platform];
        if (!config) return textResult(`❌ ${params.platform} not connected.`);

        const headers = platformHeaders(config);

        if (params.platform === "meta" && config.account_id) {
          if (params.audience_type === "lookalike") {
            const r = await apiCall(
              metaUrl(`/${config.account_id}/customaudiences`),
              "POST",
              headers,
              {
                name: params.audience_name,
                subtype: "LOOKALIKE",
                origin_audience_id: params.source,
                lookalike_spec: JSON.stringify({
                  ratio: (params.lookalike_percentage || 1) / 100,
                  country: "US",
                }),
              },
            );
            return textResult(
              r.data?.id
                ? `✅ Meta lookalike audience: ${r.data.id}`
                : `❌ ${r.data?.error?.message || r.status}`,
            );
          }
          if (params.audience_type === "website_visitors") {
            const r = await apiCall(
              metaUrl(`/${config.account_id}/customaudiences`),
              "POST",
              headers,
              {
                name: params.audience_name,
                rule: JSON.stringify({
                  inclusions: {
                    operator: "or",
                    rules: [
                      {
                        event_sources: [{ id: config.pixel_id, type: "pixel" }],
                        retention_seconds: (params.retention_days || 30) * 86400,
                      },
                    ],
                  },
                }),
                subtype: "WEBSITE",
              },
            );
            return textResult(
              r.data?.id
                ? `✅ Meta website audience: ${r.data.id}`
                : `❌ ${r.data?.error?.message || r.status}`,
            );
          }
        }

        // Store locally for other platforms
        const audience = {
          id: `AUD-${Date.now().toString(36)}`,
          platform: params.platform,
          name: params.audience_name,
          type: params.audience_type,
          source: params.source,
          created_at: new Date().toISOString(),
        };
        if (!mkt.audiences) mkt.audiences = [];
        mkt.audiences.push(audience);
        await saveMarketing(api, params.business_id, mkt);

        return textResult(
          `Audience ${audience.id} created: "${params.audience_name}" (${params.audience_type}) on ${params.platform}`,
        );
      },
    },

    // --- WhatsApp Business Messaging ---
    {
      name: "whatsapp_send",
      label: "WhatsApp Business Message",
      description:
        "Send a WhatsApp Business message — templates, text, images, documents, or interactive messages with buttons.",
      parameters: WhatsAppMessageParams,
      async execute(_id: string, params: Static<typeof WhatsAppMessageParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        const config = mkt.platforms["whatsapp"] || mkt.platforms["meta"];
        if (!config)
          return textResult(
            "❌ WhatsApp not connected. Use `marketing_connect` with platform: whatsapp.",
          );

        const phoneId = config.extra?.phone_number_id || config.page_id;
        if (!phoneId) return textResult("❌ No WhatsApp phone_number_id configured.");

        const headers = platformHeaders(config);
        let body: any = {
          messaging_product: "whatsapp",
          to: params.to,
        };

        if (params.message_type === "template") {
          body.type = "template";
          body.template = {
            name: params.template_name,
            language: { code: "en" },
            ...(params.template_params?.length
              ? {
                  components: [
                    {
                      type: "body",
                      parameters: params.template_params.map((p) => ({ type: "text", text: p })),
                    },
                  ],
                }
              : {}),
          };
        } else if (params.message_type === "text") {
          body.type = "text";
          body.text = { body: params.text };
        } else if (params.message_type === "image") {
          body.type = "image";
          body.image = { link: params.media_url, caption: params.text };
        } else if (params.message_type === "interactive" && params.buttons) {
          body.type = "interactive";
          body.interactive = {
            type: "button",
            body: { text: params.text },
            action: {
              buttons: params.buttons.map((b, i) => ({
                type: "reply",
                reply: { id: `btn_${i}`, title: b.text },
              })),
            },
          };
        }

        const r = await apiCall(metaUrl(`/${phoneId}/messages`), "POST", headers, body);
        return textResult(
          r.data?.messages?.[0]?.id
            ? `✅ WhatsApp sent to ${params.to}: ${r.data.messages[0].id}`
            : `❌ WhatsApp: ${r.data?.error?.message || r.status}`,
        );
      },
    },

    // --- Content Calendar ---
    {
      name: "content_calendar",
      label: "Content Calendar",
      description:
        "Manage the content calendar — view, add, or remove scheduled content across platforms.",
      parameters: ContentCalendarParams,
      async execute(_id: string, params: Static<typeof ContentCalendarParams>) {
        const mkt = await loadMarketing(api, params.business_id);
        if (!mkt.calendar) mkt.calendar = [];

        if (params.action === "add" && params.entry) {
          const entry = {
            id: `CAL-${Date.now().toString(36)}`,
            ...params.entry,
            status: params.entry.status || "planned",
          };
          mkt.calendar.push(entry);
          await saveMarketing(api, params.business_id, mkt);
          return textResult(
            `Content scheduled: "${params.entry.topic}" on ${params.entry.date} → ${params.entry.platforms.join(", ")}`,
          );
        }

        if (params.action === "remove" && params.entry) {
          mkt.calendar = mkt.calendar.filter(
            (e: any) => e.topic !== params.entry!.topic || e.date !== params.entry!.date,
          );
          await saveMarketing(api, params.business_id, mkt);
          return textResult("Entry removed from calendar.");
        }

        // View
        let entries = mkt.calendar;
        if (params.date_from) entries = entries.filter((e: any) => e.date >= params.date_from!);
        if (params.date_to) entries = entries.filter((e: any) => e.date <= params.date_to!);
        entries.sort((a: any, b: any) => a.date.localeCompare(b.date));

        if (entries.length === 0) return textResult("Content calendar is empty.");

        const output = entries
          .map((e: any) => {
            const icon =
              e.status === "published"
                ? "✅"
                : e.status === "approved"
                  ? "👍"
                  : e.status === "drafted"
                    ? "📝"
                    : "📅";
            return `${icon} **${e.date}** — ${e.topic} [${e.platforms.join(", ")}] (${e.status})${e.assigned_to ? ` → ${e.assigned_to}` : ""}`;
          })
          .join("\n");

        return textResult(`## 📅 Content Calendar — ${params.business_id}\n\n${output}`);
      },
    },
  ];
}
