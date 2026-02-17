# Content Syndication — Platform Publishing Reference

## Platform Publishing Methods

### LinkedIn

- API: Share API v2 (requires OAuth app)
- Method: POST to `/v2/ugcPosts`
- Auth: OAuth 2.0 access token
- Rate limit: 100 shares/day per member
- Notes: Articles need LinkedIn Publishing API (separate permission)

### Medium

- API: Medium API
- Method: POST to `/v1/users/{userId}/posts`
- Auth: Integration token
- Rate limit: Not publicly documented, ~30 posts/day safe
- Notes: Supports canonical URL for SEO

### Dev.to

- API: Forem API
- Method: POST to `/api/articles`
- Auth: API key in header
- Rate limit: 30 articles/day
- Notes: Supports canonical_url, published flag for drafts

### Hashnode

- API: GraphQL API
- Method: POST mutation `createPublicationStory`
- Auth: Personal access token
- Rate limit: ~50 requests/minute
- Notes: Supports canonical URL, tags, series

### Substack

- No public API — use email-based workflow or browser automation
- Alternative: Publish via email to your Substack publication address

### WordPress.com

- API: WordPress REST API v2
- Method: POST to `/wp/v2/posts`
- Auth: OAuth 2.0 or application password
- Rate limit: Generous, ~100 posts/day
- Notes: Self-hosted WordPress uses same API

### Reddit

- API: Reddit API (OAuth)
- Method: POST to `/api/submit`
- Auth: OAuth 2.0 (user agent required)
- Rate limit: 10 requests/minute, 100 posts/day
- Notes: Markdown formatting, respect subreddit rules

### Quora

- No public API — use browser automation or manual posting
- Notes: Quora spaces allow cross-posting

### Tumblr

- API: Tumblr API v2
- Method: POST to `/v2/blog/{blog-identifier}/post`
- Auth: OAuth 1.0a
- Rate limit: 250 posts/day, 75 photo posts
- Notes: Supports HTML content

### GitHub

- API: GitHub REST API
- Method: POST/PUT to create/update files
- Auth: Personal access token
- Rate limit: 5000 requests/hour
- Notes: Great for README files, wikis, and awesome-list contributions

### X (Twitter)

- API: X API v2
- Method: POST to `/2/tweets`
- Auth: OAuth 2.0 PKCE
- Rate limit: 100 tweets/15min (free), 17 tweets/15min (basic)
- Notes: Thread creation via reply chains

## Cross-Platform Publishing Order

Publish in this order for maximum SEO impact:

1. **Your own blog** (canonical source)
2. **Medium** (set canonical URL to your blog)
3. **Dev.to / Hashnode** (set canonical URL)
4. **LinkedIn** (republish as article)
5. **Substack** (newsletter version)
6. **Reddit** (adapted for subreddit)
7. **Quora** (as answer to relevant question)
8. **X thread** (condensed version)
9. **Aggregators** (Flipboard, Mix, etc.)
10. **Document sites** (SlideShare, Scribd, Issuu)

Setting canonical URLs prevents duplicate content penalties while building backlinks.
