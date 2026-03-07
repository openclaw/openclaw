import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { 
  Play, 
  Image, 
  Scissors, 
  Download, 
  Zap, 
  Shield, 
  Clock, 
  CheckCircle,
  ArrowRight,
  Sparkles,
  Video,
  FileImage,
  Layers
} from "lucide-react";
import { SiSpotify } from "react-icons/si";
import Header from "@/components/Header";
import SocialProofBanner from "@/components/SocialProofBanner";
import FaviconProvider from "@/components/FaviconProvider";
import fdLogo from "@/assets/fd-logo.png";

// FAQ Component
function FAQAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const faqs = [
    {
      question: "What is CUTMV?",
      answer: "CUTMV is an AI-powered video processing platform that transforms full-length music videos into multiple optimized formats including video cutdowns, GIFs, thumbnails, and Spotify Canvas. Our tool uses smart timestamp generation and professional fade effects to create viral-ready content in seconds."
    },
    {
      question: "What file formats and sizes does CUTMV support?",
      answer: "CUTMV supports all major video formats (MP4, MOV, AVI, etc.) and can handle files from 500MB up to 10GB. We process videos in under 2 minutes regardless of size, with automatic quality optimization for each output format."
    },
    {
      question: "How does CUTMV's AI timestamp generation work?",
      answer: "Our AI analyzes your video content to identify optimal cutting points based on audio peaks, visual transitions, and content structure. You can also manually input custom timestamps for precise control over your clips."
    },
    {
      question: "What aspect ratios and formats does CUTMV create?",
      answer: "CUTMV generates content in multiple formats: 16:9 and 9:16 video cutdowns, 6-second GIFs, HD thumbnails, and vertical 8-second Spotify Canvas loops. All outputs are optimized for their respective platforms."
    },
    {
      question: "What quality can I expect from CUTMV exports?",
      answer: "CUTMV delivers professional-grade, clean exports optimized for each platform. All content maintains original video quality with professional fade effects and is immediately ready for publication across social media and streaming platforms."
    },
    {
      question: "How much does CUTMV cost?",
      answer: "CUTMV operates on a simple pay-per-use model: Video cutdowns cost $0.99 each, GIF packs (10 clips) and thumbnail packs (10 images) are $1.99 each, and Spotify Canvas packs (5 loops) are $4.99. You only pay for what you create."
    }
  ];

  const toggleAccordion = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <div className="space-y-4">
      {faqs.map((faq, index) => (
        <div key={index} className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            className="w-full p-4 text-left flex justify-between items-center hover:bg-gray-50 transition-colors"
            onClick={() => toggleAccordion(index)}
          >
            <span className="font-medium text-gray-900">{faq.question}</span>
            <div className="w-8 h-8 bg-black rounded-full flex items-center justify-center flex-shrink-0 ml-4">
              <span className="text-white text-lg font-light">
                {openIndex === index ? '−' : '+'}
              </span>
            </div>
          </button>
          {openIndex === index && (
            <div className="px-4 pb-4 text-gray-600 leading-relaxed animate-in slide-in-from-top-2 duration-200">
              {faq.answer}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Landing() {
  const [email, setEmail] = useState("");
  const { user, isLoading } = useAuth();

  const handleGetStarted = () => {
    // If user is already authenticated, go to dashboard
    if (user) {
      window.location.href = '/dashboard';
    } else {
      // Otherwise redirect to login (no email pre-filling for security)
      window.location.href = '/login';
    }
  };

  return (
    <FaviconProvider 
      title="CUTMV - AI-Powered Video Creation Platform | Full Digital"
      description="Transform your music videos into professional clips, GIFs, thumbnails, and Spotify Canvas with CUTMV's AI-powered platform. Commercial-quality exports for creators."
    >
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white">
        <Header />
        <SocialProofBanner />
      
      {/* Hero Section - Original CUTMV Style */}
      <section className="relative py-20 px-6 bg-black text-white">
        <div className="container mx-auto max-w-6xl text-center">
          <h1 className="text-4xl md:text-6xl font-bold mb-8 leading-tight">
            Turn Your Music Videos into <span className="text-brand-green">Viral Assets</span> — In Seconds
          </h1>
          
          <p className="text-xl text-gray-300 mb-12 max-w-3xl mx-auto leading-relaxed">
            AI-powered platform that instantly transforms full-length music 
            videos into optimized formats for today's platforms — <span className="text-brand-green">Spotify 
            Canvases, Reels, Shorts, GIFs, and more.</span>
          </p>

          {/* Feature Cards */}
          <div className="grid md:grid-cols-3 gap-8 mb-12 max-w-4xl mx-auto">
            <div className="bg-black p-6 rounded-lg border border-gray-700">
              <div className="text-yellow-400 text-3xl mb-4">⚡</div>
              <h3 className="text-lg font-bold mb-2 text-white">No editing skills needed</h3>
              <p className="text-gray-400 text-sm">Smart timestamps handle everything</p>
            </div>
            
            <div className="bg-black p-6 rounded-lg border border-gray-700">
              <div className="text-red-400 text-3xl mb-4">🚀</div>
              <h3 className="text-lg font-bold mb-2 text-white">Built for speed</h3>
              <p className="text-gray-400 text-sm">AI delivers professional-grade results instantly</p>
            </div>
            
            <div className="bg-black p-6 rounded-lg border border-gray-700">
              <div className="text-pink-400 text-3xl mb-4">💥</div>
              <h3 className="text-lg font-bold mb-2 text-white">Built for impact</h3>
              <p className="text-gray-400 text-sm">Intelligent optimization for viral content</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center max-w-md mx-auto mb-8">
            <Button 
              onClick={handleGetStarted} 
              size="lg" 
              className="bg-brand-green hover:bg-brand-green-dark text-brand-black font-bold px-8 py-4"
            >
              {user ? 'Go to Dashboard →' : 'Start Creating Now →'}
            </Button>
          </div>

          <p className="text-sm text-gray-400">
            Upload your music video below and see the magic happen!
          </p>


        </div>
      </section>

      {/* Choose Your Output Type Section */}
      <section className="py-20 px-6 bg-white">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4 text-black">Choose Your Output Type</h2>
            <p className="text-gray-600 text-lg max-w-2xl mx-auto">
              Transform your music videos into multiple formats optimized for different platforms and use cases.
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200 hover:shadow-xl transition-shadow">
              <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                <Scissors className="w-6 h-6 text-blue-600" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Video Cutdowns</h3>
              <p className="text-gray-600 text-sm">
                Precise clips from timestamps in 16:9 and 9:16 aspect ratios
              </p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200 hover:shadow-xl transition-shadow">
              <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-4">
                <FileImage className="w-6 h-6 text-purple-600" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Animated GIFs</h3>
              <p className="text-gray-600 text-sm">
                Pack of 10 × 6-second looping GIFs for social media engagement
              </p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200 hover:shadow-xl transition-shadow">
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-4">
                <Image className="w-6 h-6 text-green-600" />
              </div>
              <h3 className="text-lg font-semibold mb-2">HD Thumbnails</h3>
              <p className="text-gray-600 text-sm">
                Pack of 10 × high-quality still frames for video previews and covers
              </p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200 hover:shadow-xl transition-shadow">
              <div className="w-12 h-12 bg-black rounded-lg flex items-center justify-center mb-4">
                <SiSpotify className="w-6 h-6 text-green-500" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Spotify Canvas</h3>
              <p className="text-gray-600 text-sm">
                Pack of 5 × 8-second vertical loops optimized for Spotify's Canvas format
              </p>
            </div>
          </div>

          <div className="text-center mt-12">
            <Button onClick={handleGetStarted} size="lg" className="bg-brand-green hover:bg-brand-green-dark text-brand-black font-bold px-8 py-4">
              {user ? 'Go to Dashboard →' : 'Get Started →'}
            </Button>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-4xl">
          <h2 className="text-3xl font-bold text-center mb-16">How It Works</h2>
          
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Video className="w-8 h-8 text-green-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2">1. Upload Video</h3>
              <p className="text-gray-600">
                Upload your video file and optionally provide timestamps for specific segments
              </p>
            </div>

            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-8 h-8 text-blue-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2">2. AI Processing</h3>
              <p className="text-gray-600">
                Our AI analyzes your content and generates outputs in your selected formats
              </p>
            </div>

            <div className="text-center">
              <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Download className="w-8 h-8 text-purple-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2">3. Download Results</h3>
              <p className="text-gray-600">
                Get clean, professional files delivered via email and dashboard download
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-20 px-4 bg-green-50">
        <div className="container mx-auto max-w-6xl">
          <h2 className="text-3xl font-bold text-center mb-16">Why Choose CUTMV</h2>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            <div className="flex items-start space-x-3">
              <CheckCircle className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">Professional Quality</h3>
                <p className="text-gray-600 text-sm">Clean, professional outputs ready for client presentations</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Zap className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">AI-Powered Speed</h3>
                <p className="text-gray-600 text-sm">Process videos in minutes, not hours of manual editing</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Layers className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">Multiple Formats</h3>
                <p className="text-gray-600 text-sm">Get all the content types you need from a single upload</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Shield className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">Secure Processing</h3>
                <p className="text-gray-600 text-sm">Your videos are processed securely and deleted after completion</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Clock className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">Email Delivery</h3>
                <p className="text-gray-600 text-sm">Results delivered directly to your inbox when processing completes</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Play className="w-5 h-5 text-green-600 mt-1 flex-shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">Smart Timestamps</h3>
                <p className="text-gray-600 text-sm">AI understands your timestamp format and creates precise cuts</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Preview - Subscription Focused */}
      <section className="py-20 px-4 bg-black">
        <div className="container mx-auto max-w-4xl text-center">
          <h2 className="text-3xl font-bold mb-4 text-white">Simple, Transparent Pricing</h2>
          <p className="text-brand-green text-lg font-semibold mb-2">Subscribe and save 50% on all processing</p>
          <p className="text-gray-400 mb-12">Monthly credits that never expire during your subscription</p>

          {/* Subscription Tiers */}
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto mb-12">
            <div className="bg-black p-6 rounded-xl border border-gray-700 text-center">
              <h3 className="font-semibold text-lg mb-2 text-white">Starter</h3>
              <div className="text-3xl font-bold text-brand-green mb-1">$10</div>
              <p className="text-gray-500 text-sm mb-4">/month</p>
              <div className="text-white font-medium mb-2">1,000 credits</div>
              <p className="text-gray-400 text-sm">~20 video cutdowns</p>
              <p className="text-brand-green text-xs mt-3">+ 50% off all processing</p>
            </div>

            <div className="bg-black p-6 rounded-xl border-2 border-brand-green text-center relative">
              <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-green text-black">Popular</Badge>
              <h3 className="font-semibold text-lg mb-2 text-white mt-2">Pro</h3>
              <div className="text-3xl font-bold text-brand-green mb-1">$25</div>
              <p className="text-gray-500 text-sm mb-4">/month</p>
              <div className="text-white font-medium mb-2">3,000 credits</div>
              <p className="text-gray-400 text-sm">~60 video cutdowns</p>
              <p className="text-brand-green text-xs mt-3">+ Bulk ZIP downloads</p>
            </div>

            <div className="bg-black p-6 rounded-xl border border-gray-700 text-center">
              <h3 className="font-semibold text-lg mb-2 text-white">Enterprise</h3>
              <div className="text-3xl font-bold text-brand-green mb-1">$75</div>
              <p className="text-gray-500 text-sm mb-4">/month</p>
              <div className="text-white font-medium mb-2">10,000 credits</div>
              <p className="text-gray-400 text-sm">~200 video cutdowns</p>
              <p className="text-brand-green text-xs mt-3">+ Priority support</p>
            </div>
          </div>

          {/* Per-export pricing (secondary) */}
          <div className="text-gray-500 text-sm mb-8">
            <p className="mb-2">Or pay as you go:</p>
            <p>Cutdowns from 50 credits | GIF/Thumbnail packs from 90 credits | Canvas from 225 credits</p>
            <p className="text-xs text-gray-600 mt-1">Non-subscribers pay 2× rates</p>
          </div>

          <div className="mt-8">
            <Button onClick={handleGetStarted} size="lg" className="bg-brand-green hover:bg-brand-green-dark text-brand-black font-bold">
              Start Processing Videos <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-20 px-6 bg-white">
        <div className="container mx-auto max-w-2xl">
          <h2 className="text-3xl font-bold text-center mb-12">Frequently Asked Questions</h2>
          <FAQAccordion />
        </div>
      </section>

      {/* Footer - Simple like Floodifly */}
      <footer className="bg-white py-12 px-6 border-t">
        <div className="container mx-auto max-w-6xl">
          <div className="flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
            <div className="flex items-center space-x-3">
              <div className="w-6 h-6 bg-black rounded flex items-center justify-center">
                <img src={fdLogo} alt="Full Digital" className="w-4 h-4" />
              </div>
              <span className="text-lg font-bold">CUTMV</span>
            </div>
            
            <div className="flex flex-col md:flex-row space-y-2 md:space-y-0 md:space-x-8 text-sm text-center md:text-left">
              <Link href="/terms" className="text-gray-600 hover:text-black">Legal</Link>
              <Link href="/privacy" className="text-gray-600 hover:text-black">Privacy Policy</Link>
              <Link href="/terms" className="text-gray-600 hover:text-black">Terms of Service</Link>
            </div>
          </div>
          
          <div className="text-center text-sm text-gray-500 mt-8">
            © 2026 Full Digital LLC. All rights reserved.
          </div>
        </div>
      </footer>
      </div>
    </FaviconProvider>
  );
}