export default function SocialProofBanner() {
  return (
    <>
      <style>{`
        @keyframes socialproof-scroll {
          0% {
            transform: translateX(0%);
          }
          100% {
            transform: translateX(-100%);
          }
        }
        
        .socialproof-animate-scroll {
          animation: socialproof-scroll 60s linear infinite;
        }
        
        /* Faster animation on mobile devices */
        @media (max-width: 768px) {
          .socialproof-animate-scroll {
            animation: socialproof-scroll 35s linear infinite;
          }
        }
      `}</style>
      <div className="bg-white border-b border-gray-200 py-2 overflow-hidden">
        <div className="relative">
          <div className="flex socialproof-animate-scroll whitespace-nowrap">
            <div className="flex items-center gap-8 px-4 py-1 text-sm font-medium text-gray-700">
              <span className="flex items-center gap-2">
                🎯 <span>Over 10,000 videos processed to-date</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🚀 <span>New AI features dropping regularly</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                ⚡ <span>500MB-10GB files processed in under 2 minutes</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🎬 <span>Trusted by music creators worldwide</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🤖 <span>AI-powered smart timestamp generation</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                💎 <span>Professional-quality exports for every creator</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🔥 <span>9 out of 10 users see higher engagement</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🎵 <span>From bedroom producers to platinum artists</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                💰 <span>Generate revenue from existing content</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🎯 <span>Over 10,000 videos processed to-date</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🚀 <span>New AI features dropping regularly</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                ⚡ <span>500MB-10GB files processed in under 2 minutes</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🎬 <span>Trusted by music creators worldwide</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                🤖 <span>AI-powered smart timestamp generation</span>
              </span>
              <span className="text-gray-300">•</span>
              <span className="flex items-center gap-2">
                💎 <span>Professional-quality exports for every creator</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}