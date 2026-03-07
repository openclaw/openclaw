import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Calendar, Share2, ExternalLink, Sparkles, User } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import fdLogo from '@/assets/fd-logo.png';
import Header from '@/components/Header';

interface BlogPost {
  id: string;
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  published: boolean;
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const { toast } = useToast();

  const { data: post, isLoading, error } = useQuery<BlogPost>({
    queryKey: ['/api/blog/posts', slug],
    enabled: !!slug,
  });

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: post?.title,
          text: post?.excerpt,
          url: url,
        });
      } catch (err) {
        // Fallback to clipboard
        copyToClipboard(url);
      }
    } else {
      copyToClipboard(url);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({
        title: "Link copied",
        description: "Blog post link copied to clipboard",
      });
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-200 rounded w-1/4 mb-8"></div>
            <div className="h-12 bg-gray-200 rounded w-3/4 mb-4"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2 mb-8"></div>
            <div className="space-y-4">
              <div className="h-4 bg-gray-200 rounded w-full"></div>
              <div className="h-4 bg-gray-200 rounded w-full"></div>
              <div className="h-4 bg-gray-200 rounded w-2/3"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !post || !post.published) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">Post not found</h1>
          <p className="text-gray-600 mb-8">The blog post you're looking for doesn't exist or hasn't been published yet.</p>
          <Link href="/blog">
            <Button>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Blog
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* SEO Meta Tags */}
      <title>{post?.title} | CUTMV Blog - AI-Powered Music Video Insights</title>
      <meta name="description" content={post?.excerpt} />
      <meta name="keywords" content="AI video editing, music video tools, video editing software, music industry, content creation, video clips, social media content, music promotion" />
      <meta property="og:title" content={post?.title} />
      <meta property="og:description" content={post?.excerpt} />
      <meta property="og:type" content="article" />
      <meta property="og:url" content={`https://cutmv.fulldigitalll.com/blog/${post?.slug}`} />
      <meta name="author" content={post?.author} />
      <meta name="article:published_time" content={post?.publishedAt} />
      
      {/* Header */}
      <Header />

      {/* Article */}
      <article className="max-w-6xl mx-auto px-6 py-16">
        {/* Article Header */}
        <header className="mb-16 max-w-4xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <Badge variant="secondary" className="bg-brand-green/10 text-brand-green border-brand-green/20">
              <Sparkles className="w-3 h-3 mr-1" />
              AI Insights
            </Badge>
            <div className="flex items-center text-sm text-gray-500">
              <Calendar className="w-4 h-4 mr-1" />
              {new Date(post.publishedAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}
            </div>
            <div className="flex items-center text-sm text-gray-500">
              <User className="w-4 h-4 mr-1" />
              Reading time: ~5 min
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 mb-6 leading-tight">
            {post.title}
          </h1>
          <p className="text-xl md:text-2xl text-gray-600 leading-relaxed mb-8">
            {post.excerpt}
          </p>
          <div className="flex items-center gap-3 pb-6 border-b border-gray-200">
            <img src={fdLogo} alt="Full Digital" className="h-8 w-8" />
            <div>
              <div className="text-sm font-semibold text-gray-900">By {post.author}</div>
              <div className="text-sm text-gray-500">Full Digital Design Agency</div>
            </div>
          </div>
        </header>

        {/* Article Content */}
        <div className="max-w-4xl mx-auto">
          <div 
            className="prose prose-xl max-w-none 
              prose-headings:text-gray-900 prose-headings:font-bold prose-headings:tracking-tight
              prose-h2:text-3xl prose-h2:mt-12 prose-h2:mb-6
              prose-h3:text-2xl prose-h3:mt-8 prose-h3:mb-4
              prose-p:text-gray-700 prose-p:leading-relaxed prose-p:mb-6 prose-p:text-lg
              prose-a:text-brand-green prose-a:no-underline hover:prose-a:underline prose-a:font-medium
              prose-strong:text-gray-900 prose-strong:font-semibold
              prose-ul:text-gray-700 prose-ol:text-gray-700
              prose-li:text-lg prose-li:leading-relaxed prose-li:mb-2
              prose-blockquote:border-brand-green prose-blockquote:bg-brand-green/5 prose-blockquote:p-6 prose-blockquote:rounded-lg"
            dangerouslySetInnerHTML={{ __html: post.content }}
          />
        </div>

        {/* Article Footer */}
        <footer className="mt-20 max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-12 pt-8 border-t border-gray-200">
            <div className="flex items-center gap-3">
              <img src={fdLogo} alt="Full Digital" className="h-6 w-6" />
              <div className="text-sm text-gray-500">
                Published on {new Date(post.publishedAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })} by {post.author}
              </div>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleShare}
              className="border-brand-green text-brand-green hover:bg-brand-green hover:text-white"
            >
              <Share2 className="w-4 h-4 mr-2" />
              Share this post
            </Button>
          </div>
          
          {/* Enhanced CTA */}
          <div className="bg-gradient-to-r from-brand-green/10 to-blue-50 rounded-2xl p-12 text-center">
            <Sparkles className="mx-auto h-12 w-12 text-brand-green mb-6" />
            <h3 className="text-3xl font-bold text-gray-900 mb-4">Ready to Transform Your Music Videos?</h3>
            <p className="text-lg text-gray-700 mb-8 max-w-2xl mx-auto leading-relaxed">
              Put these insights into action with CUTMV's AI-powered video editing tools. Create professional content optimized for every platform in minutes, not hours.
            </p>
            <div className="flex items-center justify-center gap-6">
              <Link href="/">
                <Button size="lg" className="bg-brand-green hover:bg-brand-green/90 text-lg px-8 py-3">
                  Try CUTMV Free
                </Button>
              </Link>
              <a 
                href="https://fulldigitalll.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-brand-green hover:underline font-semibold text-lg"
              >
                Explore Full Digital Services →
              </a>
            </div>
          </div>

          {/* Related Articles Section */}
          <div className="mt-16 p-8 bg-gray-50 rounded-xl">
            <h4 className="text-xl font-bold text-gray-900 mb-4">Stay Updated with CUTMV Insights</h4>
            <p className="text-gray-600 mb-6">
              Get the latest AI video editing tips and music industry trends delivered to your inbox.
            </p>
            <div className="flex items-center gap-4">
              <Link href="/blog">
                <Button variant="outline" className="border-brand-green text-brand-green hover:bg-brand-green hover:text-white">
                  Read More Articles
                </Button>
              </Link>
              <a 
                href="/blog/rss" 
                className="text-brand-green hover:underline font-medium"
              >
                Subscribe to RSS Feed →
              </a>
            </div>
          </div>
        </footer>
      </article>
    </div>
  );
}