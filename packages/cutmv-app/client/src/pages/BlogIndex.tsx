import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PenTool, Calendar, ArrowRight, Rss, Zap, Target, Sparkles, ArrowUpRight } from 'lucide-react';
import fdLogo from '@/assets/fd-logo.png';
import { trackBlogInteraction, trackPageView } from '@/lib/posthog';
import { useEffect } from 'react';
import Header from '@/components/Header';

interface BlogPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  author: string;
  publishedAt: string;
  published: boolean;
}

export default function BlogIndex() {
  const { data: posts, isLoading } = useQuery<BlogPost[]>({
    queryKey: ['/api/blog/posts'],
  });

  const publishedPosts = posts?.filter(post => post.published) || [];

  // Track page view
  useEffect(() => {
    trackPageView('blog_index', {
      post_count: publishedPosts.length
    });
  }, [publishedPosts.length]);

  return (
    <div className="min-h-screen bg-background">
      {/* SEO Meta Tags */}
      <title>CUTMV Blog - AI-Powered Music Video Editing Insights | Full Digital</title>
      <meta name="description" content="Discover expert insights on AI-powered video editing and music industry trends, curated by Full Digital's human staff with AI research assistance. Transform your music video workflow today." />
      <meta name="keywords" content="AI video editing, music video tools, video editing software, music industry, content creation, video clips, social media content, music promotion" />
      <meta property="og:title" content="CUTMV Blog - AI-Powered Music Video Editing Insights" />
      <meta property="og:description" content="Expert insights on AI-powered video editing and music industry trends from Full Digital's CUTMV team." />
      <meta property="og:type" content="website" />
      <meta property="og:url" content="https://cutmv.fulldigitalll.com/blog" />

      {/* Modern Header with Brand Colors */}
      <Header />

      {/* Hero Section */}
      <section className="bg-gradient-to-r from-neutral-900 via-neutral-800 to-neutral-900 border-b border-neutral-700">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="text-center space-y-6">
            <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
              Master the Future of <span className="text-brand-green">Music Video Creation</span>
            </h2>
            <p className="text-xl text-neutral-300 max-w-3xl mx-auto leading-relaxed">
              From AI-powered editing techniques to industry insights that drive viral content — 
              <span className="text-brand-green font-semibold"> stay ahead with expert knowledge from Full Digital's creative team, enhanced with AI research and analysis.</span>
            </p>
            
            {/* Value Props */}
            <div className="grid md:grid-cols-3 gap-6 mt-12 max-w-4xl mx-auto">
              <div className="bg-neutral-700/30 border border-neutral-600 rounded-lg p-6">
                <Zap className="text-brand-green text-3xl mb-3 mx-auto" />
                <h3 className="text-white font-semibold mb-2">Industry Insights</h3>
                <p className="text-neutral-400 text-sm">Latest trends and techniques from music industry professionals</p>
              </div>
              <div className="bg-neutral-700/30 border border-neutral-600 rounded-lg p-6">
                <Target className="text-brand-green text-3xl mb-3 mx-auto" />
                <h3 className="text-white font-semibold mb-2">AI-Powered Strategies</h3>
                <p className="text-neutral-400 text-sm">Learn how AI is transforming creative workflows and content creation</p>
              </div>
              <div className="bg-neutral-700/30 border border-neutral-600 rounded-lg p-6">
                <ArrowUpRight className="text-brand-green text-3xl mb-3 mx-auto" />
                <h3 className="text-white font-semibold mb-2">Growth Tactics</h3>
                <p className="text-neutral-400 text-sm">Proven methods to boost engagement and reach across platforms</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-6 py-16">
        {isLoading ? (
          <div className="space-y-6">
            {[1, 2, 3].map(i => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-6 bg-gray-200 rounded w-3/4"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </CardHeader>
                <CardContent>
                  <div className="h-4 bg-gray-200 rounded w-full mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-2/3"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : publishedPosts.length === 0 ? (
          <div className="text-center py-16">
            <div className="bg-gradient-to-br from-brand-green/10 to-blue-50 rounded-2xl p-12 max-w-2xl mx-auto">
              <Sparkles className="mx-auto h-16 w-16 text-brand-green mb-6" />
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Coming Soon: Expert Insights</h2>
              <p className="text-gray-600 text-lg leading-relaxed mb-6">
                Our team is crafting in-depth articles on AI-powered video editing, music industry trends, and creative strategies to help you master visual content creation.
              </p>
              <div className="flex items-center justify-center gap-4">
                <Link href="/">
                  <Button className="bg-brand-green hover:bg-brand-green/90">
                    Try CUTMV Now
                  </Button>
                </Link>
                <a 
                  href="https://fulldigitalll.com" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-brand-green hover:underline font-medium"
                >
                  Explore Full Digital →
                </a>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-2 gap-8">
            {publishedPosts.map((post) => (
              <article key={post.id} className="group">
                <Card className="h-full hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-white border-gray-200">
                  <CardHeader className="pb-4">
                    <div className="flex items-center gap-3 mb-3">
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
                    </div>
                    <CardTitle className="text-2xl leading-tight group-hover:text-brand-green transition-colors duration-200">
                      <Link 
                        href={`/blog/${post.slug}`} 
                        className="block"
                        onClick={() => {
                          try {
                            trackBlogInteraction({
                              action: 'view',
                              postSlug: post.slug,
                              postTitle: post.title
                            });
                          } catch (error) {
                            console.debug('PostHog tracking error:', error);
                          }
                        }}
                      >
                        {post.title}
                      </Link>
                    </CardTitle>
                    <CardDescription className="text-base leading-relaxed text-gray-600 mt-3">
                      {post.excerpt}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <img src={fdLogo} alt="Full Digital" className="h-5 w-5" />
                        <span className="text-sm font-medium text-gray-700">By {post.author}</span>
                      </div>
                      <Link 
                        href={`/blog/${post.slug}`}
                        onClick={() => {
                          try {
                            trackBlogInteraction({
                              action: 'click_cta',
                              postSlug: post.slug,  
                              postTitle: post.title
                            });
                          } catch (error) {
                            console.debug('PostHog tracking error:', error);
                          }
                        }}
                      >
                        <Button variant="ghost" size="sm" className="group text-brand-green hover:text-brand-green hover:bg-brand-green/10">
                          Read Article
                          <ArrowRight className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              </article>
            ))}
          </div>
        )}

        {/* Call to Action Section */}
        <section className="mt-20 py-16 bg-gradient-to-r from-brand-green/10 to-blue-50 rounded-2xl">
          <div className="text-center px-8">
            <h3 className="text-3xl font-bold text-gray-900 mb-4">Ready to Transform Your Music Videos?</h3>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto mb-8">
              Put these insights into action with CUTMV's AI-powered video editing tools. Create professional content in minutes, not hours.
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
        </section>

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-gray-200">
          <div className="flex items-center justify-center">
            <div className="flex items-center text-gray-500">
              <span className="text-sm">Built by</span>
              <img src={fdLogo} alt="Full Digital" className="h-6 w-6 mx-2" />
              <a 
                href="https://fulldigitalll.com" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-brand-green hover:text-brand-green-light transition-colors text-sm font-medium"
              >
                Full Digital
              </a>
            </div>
          </div>
          <div className="text-center mt-2 space-y-1">
            <p className="text-xs text-gray-400">
              Multi-Platinum Design Agency - Artwork, Animation, AR Filters, Visualizers, Websites & More
            </p>
            <p className="text-xs text-gray-500">
              Content crafted by human experts with AI-powered research and insights
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}