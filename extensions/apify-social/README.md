# Apify Social Scraper Plugin

Social media scraping via Apify (Instagram, TikTok, YouTube, LinkedIn).

## How it works

- `social_platforms` uses a two-phase async pattern: **start** fires off scraping jobs concurrently, **collect** fetches results.
- Results are cached by run ID for 15 minutes (configurable).
- Requires `APIFY_API_KEY` env var or `apiKey` in plugin config.
- Prefer `social_platforms` over `web_fetch` for social media URLs.

## Get an API key

1. Create an Apify account at [https://console.apify.com/](https://console.apify.com/)
2. Generate an API token in Account Settings.
3. Store it in plugin config or set `APIFY_API_KEY` in the gateway environment.

## Configure

```json5
{
  plugins: {
    entries: {
      "apify-social": {
        config: {
          apiKey: "APIFY_API_KEY_HERE", // optional if APIFY_API_KEY env var is set
          enabled: true,
          baseUrl: "https://api.apify.com",
          cacheTtlMinutes: 15,
          maxResults: 20,
          allowedPlatforms: ["instagram", "tiktok", "youtube", "linkedin"],
        },
      },
    },
  },
  // Make the tool available to agents:
  tools: {
    alsoAllow: ["social_platforms"], // or "apify-social" or "group:plugins"
  },
}
```

Notes:

- `enabled` defaults to true when an API key is present.
- `allowedPlatforms` controls which platforms are available (default: all four).
- `maxResults` sets the default result limit (default: 20, max: 100).

## social_platforms

### Requirements

- Plugin must be enabled (default: enabled when apiKey is set)
- Apify API key: plugin config `apiKey` or `APIFY_API_KEY` env var

### Two-phase async pattern

1. **Start**: Call with `action: "start"` and a `requests` array to fire off scraping jobs concurrently. Returns immediately with run IDs.
2. **Collect**: Call with `action: "collect"` and the `runs` array from the start response to fetch results. Repeat if some runs are still pending.

### Tool parameters

#### Start action

- `action` (required): `"start"`
- `requests` (required): Array of request objects, each with:
  - `platform` (required): `"instagram"`, `"tiktok"`, `"youtube"`, or `"linkedin"`
  - Platform-specific parameters (see below)
  - `maxResults` (optional): Maximum results to return (1-100, default: 20)
  - `actorInput` (optional): Object with additional Actor-specific input parameters (see platform options below)

#### Collect action

- `action` (required): `"collect"`
- `runs` (required): Array of `{ runId, platform, datasetId, linkedinAction? }` objects from the start response

### Platform parameters

#### Instagram

- `instagramMode` (required): `"url"` or `"search"`
- `instagramType` (required):
  - URL mode: `"posts"`, `"comments"`, `"mentions"`, `"urls"`
  - Search mode: `"hashtags"`, `"places"`, `"users"`
- URL mode requires `urls`, search mode requires `queries`

**actorInput options:**

- `resultsType`: what to scrape -- `posts` | `comments` | `details` | `mentions` | `reels`
- `resultsLimit`: max results per URL
- `onlyPostsNewerThan`: date filter, e.g. `"2024-01-01"` or `"7 days"`
- `searchType`: `user` | `hashtag` | `place`
- `searchLimit`: max search results (1-250)
- `addParentData`: add source metadata to results

#### TikTok

- `tiktokType` (required): `"search"`, `"hashtags"`, `"videos"`, or `"profiles"`
  - `"search"` requires `queries`
  - `"hashtags"` requires `hashtags`
  - `"videos"` requires `urls`
  - `"profiles"` requires `profiles`

**actorInput options:**

- `resultsPerPage`: results per hashtag/profile/search (1-1000000)
- `profileScrapeSections`: sections to scrape -- `["videos"]`, `["reposts"]`, or both
- `profileSorting`: `latest` | `popular` | `oldest`
- `excludePinnedPosts`: exclude pinned posts from profiles
- `oldestPostDateUnified`: date filter, e.g. `"2024-01-01"` or `"30 days"`
- `newestPostDate`: scrape videos before this date
- `leastDiggs` / `mostDiggs`: popularity filters (min/max hearts)
- `searchSection`: `""` (Top) | `"/video"` (Video) | `"/user"` (Profile)
- `maxProfilesPerQuery`: max profiles for profile searches
- `searchSorting`: `"0"` (relevant) | `"1"` (most liked) | `"3"` (latest)
- `searchDatePosted`: `"0"` (all time) | `"1"` (24h) | `"2"` (week) | `"3"` (month) | `"4"` (3 months) | `"5"` (6 months)
- `scrapeRelatedVideos`: scrape related videos for video URLs
- `shouldDownloadVideos` / `shouldDownloadSubtitles` / `shouldDownloadCovers` / `shouldDownloadAvatars` / `shouldDownloadSlideshowImages` / `shouldDownloadMusicCovers`: download toggles
- `commentsPerPost` / `maxRepliesPerComment`: comments scraping
- `maxFollowersPerProfile` / `maxFollowingPerProfile`: followers/following scraping (charged)
- `proxyCountryCode`: ISO country code for proxy, e.g. `"US"`

#### YouTube

- Provide `urls` (video/channel/playlist URLs) or `queries` (search terms)

**actorInput options:**

- `maxResults`: max videos per search term
- `maxResultsShorts`: max shorts per search
- `maxResultStreams`: max streams per search
- `downloadSubtitles`: download video subtitles
- `subtitlesLanguage`: `any` | `en` | `de` | `es` | `fr` | `it` | `ja` | `ko` | `nl` | `pt` | `ru`
- `subtitlesFormat`: `srt` | `vtt` | `xml` | `plaintext`
- `preferAutoGeneratedSubtitles`: prefer auto-generated subtitles
- `sortingOrder`: `relevance` | `rating` | `date` | `views`
- `dateFilter`: `hour` | `today` | `week` | `month` | `year`
- `videoType`: `video` | `movie`
- `lengthFilter`: `under4` | `between420` | `plus20`
- `isHD` / `is4K` / `isLive` / `hasSubtitles` / `hasCC`: search feature filters
- `oldestPostDate`: date filter for channel scraping, e.g. `"2024-01-01"` or `"30 days"`
- `sortVideosBy`: `NEWEST` | `POPULAR` | `OLDEST`

#### LinkedIn

- `linkedinAction` (required): `"profiles"`, `"company"`, or `"jobs"`

**Profiles** (`linkedinAction: "profiles"`):

- Provide `urls` (profile URLs) and/or `profiles` (usernames)
- Returns: profile info, work experience, education, certifications
- Up to 1000 profiles per batch

**Company** (`linkedinAction: "company"`):

- Requires `urls` (LinkedIn company profile URLs, e.g. `https://www.linkedin.com/company/tesla-motors`)
- `includePosts` (optional, default: `true`): also scrape company posts using the same URLs
- When `includePosts=true`, fires two concurrent runs (details + posts) returning two run references
- Returns: company name, industry, website, employee count, description, specialities

**Jobs** (`linkedinAction: "jobs"`):

- Requires `urls` (LinkedIn jobs search URLs from `linkedin.com/jobs/search/`)
- Returns: job title, company, location, salary, description

**actorInput options:**

- Profiles: `includeEmail` (boolean, default: false) -- include email if available
- Company posts: `limit` (number, 1-100, default: 100) -- max posts per company
- Jobs: `scrapeCompany` (boolean, default: true) -- include company details with job listings
- Jobs: `count` (number, min 100) -- limit total jobs scraped
- Jobs: `splitByLocation` (boolean, default: false) -- split search by city to bypass 1000 job limit
- Jobs: `splitCountry` (string) -- country code for location split (e.g. `"US"`, `"GB"`)

### Platform capabilities

| Platform      | Actions                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| **Instagram** | Scrape URLs (posts, comments, mentions) or search (hashtags, places, users) |
| **TikTok**    | Search queries, hashtags, video URLs, or profiles                           |
| **YouTube**   | Search terms or direct video/channel URLs                                   |
| **LinkedIn**  | Profile details, company info + posts, or job listings                      |

### Examples

```javascript
// Start: scrape Instagram and TikTok concurrently
const startResult = await social_platforms({
  action: "start",
  requests: [
    {
      platform: "instagram",
      instagramMode: "url",
      instagramType: "posts",
      urls: ["https://www.instagram.com/natgeo/"],
      maxResults: 10,
    },
    {
      platform: "tiktok",
      tiktokType: "search",
      queries: ["AI tools"],
      actorInput: {
        searchSection: "/video",
        searchSorting: "3",
      },
    },
  ],
});
// -> { runs: [{ runId, platform, datasetId }, ...] }

// Collect results
const collectResult = await social_platforms({
  action: "collect",
  runs: startResult.runs,
});
// -> { completed: [...], pending: [...] }

// YouTube with subtitles and date filter
await social_platforms({
  action: "start",
  requests: [
    {
      platform: "youtube",
      queries: ["web scraping 2025"],
      maxResults: 5,
      actorInput: {
        downloadSubtitles: true,
        subtitlesLanguage: "en",
        sortingOrder: "date",
        dateFilter: "month",
      },
    },
  ],
});

// LinkedIn: scrape company details + posts, and profiles in parallel
await social_platforms({
  action: "start",
  requests: [
    {
      platform: "linkedin",
      linkedinAction: "company",
      urls: ["https://www.linkedin.com/company/tesla-motors"],
    },
    {
      platform: "linkedin",
      linkedinAction: "profiles",
      profiles: ["satyanadella", "neal-mohan"],
    },
  ],
});
// -> company action returns 2 run refs (details + posts), profiles returns 1

// LinkedIn: scrape job listings
await social_platforms({
  action: "start",
  requests: [
    {
      platform: "linkedin",
      linkedinAction: "jobs",
      urls: [
        "https://www.linkedin.com/jobs/search/?keywords=software+engineer&location=San+Francisco",
      ],
      actorInput: {
        scrapeCompany: true,
        count: 200,
      },
    },
  ],
});
```

- Responses are cached (default 15 minutes) to reduce repeated API calls.
- If you use tool profiles/allowlists, add `social_platforms` or `group:plugins`.
