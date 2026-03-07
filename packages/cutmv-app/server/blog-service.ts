// AI-Powered Blog Post Generation Service
import OpenAI from "openai";
import { nanoid } from 'nanoid';

interface BlogPostContent {
  title: string;
  content: string;
  excerpt: string;
  slug: string;
}

class BlogService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ 
        apiKey: process.env.OPENAI_API_KEY 
      });
      console.log('📝 Blog Service initialized with OpenAI');
    } else {
      console.log('⚠️ OpenAI API key not found - blog generation disabled');
    }
  }

  async generateBlogPost(topic: string, targetAudience: string = 'general', tone: string = 'professional'): Promise<BlogPostContent | null> {
    if (!this.openai) {
      throw new Error('OpenAI not configured');
    }

    try {
      const systemPrompt = `You are an AI writing assistant working alongside Full Digital's human staff to create expert content for CUTMV, an AI-powered music video editing platform. 

Your task is to write comprehensive, engaging blog posts that:
- Are confident and professional in tone
- Show cultural awareness of hip-hop, music tech, and creator economy
- Speak to designers, editors, and creatives
- Include clear examples and use cases of CUTMV
- Always end with strong calls-to-action linking back to Full Digital
- NEVER USE EMOJIS in the content - keep it professional and text-only

CUTMV Key Features:
- AI-powered video cutdowns and clips
- Automated thumbnail and GIF generation
- Spotify Canvas creation
- Multiple aspect ratio exports (16:9, 9:16)
- Professional fade effects
- Real-time processing with progress tracking

Write in a tone that's: ${tone === 'cultural' ? 'culture-forward (hip-hop, music tech, creator economy)' : tone}
Target audience: ${targetAudience === 'artists' ? 'independent artists and musicians' : targetAudience === 'labels' ? 'record labels and music executives' : targetAudience === 'creators' ? 'content creators and social media managers' : 'general music industry professionals'}

Format the response as JSON with:
{
  "title": "SEO-optimized title (60 chars max)",
  "content": "Full HTML blog post content with headers, paragraphs, bullets",
  "excerpt": "Compelling 150-character summary"
}

Content Structure:
1. Bold intro paragraph mentioning CUTMV
2. 3-4 main sections with H2 headers and subpoints
3. Include specific CUTMV features and benefits
4. End with "Built by Full Digital — visit fulldigitalll.com to learn more."

Note: This content is created through collaboration between Full Digital's human experts and AI research capabilities.`;

      const userPrompt = `Write a comprehensive blog post about: ${topic}

Make sure to:
- Mention CUTMV clearly in the first 2 sections
- Include specific examples of how CUTMV helps ${targetAudience}
- Use industry-relevant terminology and trends
- Include actionable insights and tips
- End with a strong call-to-action linking to Full Digital`;

      // the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
        max_tokens: 3000,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      if (!result.title || !result.content || !result.excerpt) {
        throw new Error('Invalid response format from OpenAI');
      }

      // Generate URL-friendly slug
      const slug = this.generateSlug(result.title);

      return {
        title: result.title,
        content: result.content,
        excerpt: result.excerpt,
        slug: slug
      };

    } catch (error) {
      console.error('Blog generation error:', error);
      throw error;
    }
  }

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
  }

  // Generate RSS feed content
  generateRSSFeed(posts: any[]): string {
    const baseUrl = 'https://cutmv.fulldigitalll.com';
    const now = new Date().toUTCString();

    const items = posts
      .filter(post => post.published)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, 20)
      .map(post => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${baseUrl}/blog/${post.slug}</link>
      <description><![CDATA[${post.excerpt}]]></description>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
      <guid>${baseUrl}/blog/${post.slug}</guid>
    </item>`).join('');

    return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>CUTMV Blog - AI-Powered Music Video Tools</title>
    <link>${baseUrl}/blog</link>
    <description>Insights on AI-powered video editing, music industry trends, and creative content tools from the CUTMV team at Full Digital.</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <generator>CUTMV Blog System</generator>
    ${items}
  </channel>
</rss>`;
  }
}

export const blogService = new BlogService();