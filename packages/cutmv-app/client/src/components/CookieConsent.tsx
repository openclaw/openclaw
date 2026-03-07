import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { X, Cookie, Shield, Eye } from 'lucide-react';

// Global singleton to prevent multiple consent banners
let globalConsentState: {
  hasChecked: boolean;
  consentValue: string | null;
  isVisible: boolean;
  subscribers: Set<() => void>;
} = {
  hasChecked: false,
  consentValue: null,
  isVisible: false,
  subscribers: new Set()
};

interface CookieConsentProps {
  onAccept?: () => void;
  onDecline?: () => void;
}

export default function CookieConsent({ onAccept, onDecline }: CookieConsentProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const hasInitialized = useRef(false);

  useEffect(() => {
    // Prevent multiple instances from running the check
    if (hasInitialized.current || globalConsentState.hasChecked) {
      setIsVisible(globalConsentState.isVisible);
      return;
    }

    // Mark as initialized
    hasInitialized.current = true;
    globalConsentState.hasChecked = true;

    const checkConsent = () => {
      try {
        // Double-check localStorage availability
        if (typeof Storage === 'undefined' || !window.localStorage) {
          console.log('🍪 localStorage not available, showing consent');
          globalConsentState.isVisible = true;
          setIsVisible(true);
          return;
        }

        const hasConsented = localStorage.getItem('cutmv-cookie-consent');
        const consentTimestamp = localStorage.getItem('cutmv-cookie-timestamp');
        
        // Also check for domain-scoped consent cookie
        const domainConsent = document.cookie.split(';').find(c => c.trim().startsWith('cutmv-consent='));
        const hasDomainConsent = domainConsent?.split('=')[1] === 'accepted';
        
        console.log('🍪 Consent check (singleton):', { 
          hasConsented, 
          hasDomainConsent,
          timestamp: !!consentTimestamp, 
          url: window.location.pathname 
        });
        
        // Cache the consent value globally
        globalConsentState.consentValue = hasConsented || (hasDomainConsent ? 'accepted' : null);
        
        // Extended validity check - consent lasts until manually cleared
        if ((hasConsented && ['accepted', 'declined', 'essential-only'].includes(hasConsented)) || hasDomainConsent) {
          // Check if consent is older than 1 year (365 days) for refresh
          const consentAge = consentTimestamp ? Date.now() - new Date(consentTimestamp).getTime() : 0;
          const oneYear = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
          
          if (consentAge < oneYear || !consentTimestamp) {
            console.log('🍪 Valid consent found (extended validity):', hasConsented);
            globalConsentState.isVisible = false;
            setIsVisible(false);
            return;
          } else {
            console.log('🍪 Consent expired after 1 year, requesting fresh consent');
            // Clear expired consent
            localStorage.removeItem('cutmv-cookie-consent');
            localStorage.removeItem('cutmv-cookie-timestamp');
          }
        }
        
        // Only show if truly no consent
        if (!hasConsented || !['accepted', 'declined', 'essential-only'].includes(hasConsented)) {
          console.log('🍪 No valid consent, showing banner');
          setTimeout(() => {
            globalConsentState.isVisible = true;
            setIsVisible(true);
          }, 500);
        }
      } catch (error) {
        console.error('🍪 localStorage error:', error);
        // Show banner on any error
        setTimeout(() => {
          globalConsentState.isVisible = true;
          setIsVisible(true);
        }, 500);
      }
    };

    // Check consent once globally
    checkConsent();
  }, []); // No dependencies to prevent re-runs

  const handleAccept = () => {
    try {
      // Set both values with more persistent mobile approach
      localStorage.setItem('cutmv-cookie-consent', 'accepted');
      localStorage.setItem('cutmv-cookie-timestamp', new Date().toISOString());
      
      // Set domain-scoped consent cookie for production cross-subdomain sharing
      const isProduction = window.location.hostname.includes('fulldigitalll.com');
      if (isProduction) {
        document.cookie = `cutmv-consent=accepted; Max-Age=31536000; Secure; SameSite=Lax; Domain=.fulldigitalll.com; Path=/`;
      } else {
        document.cookie = `cutmv-consent=accepted; Max-Age=31536000; SameSite=Lax; Path=/`;
      }
      
      // Update global state to prevent other instances
      globalConsentState.consentValue = 'accepted';
      globalConsentState.isVisible = false;
      
      // Multiple verification attempts for mobile reliability
      const verification = localStorage.getItem('cutmv-cookie-consent');
      console.log('🍪 Consent saved and verified (global):', verification);
      
      // Immediately hide banner to prevent re-appearance
      setIsVisible(false);
      
      // Enable analytics without page reload (mobile-friendly)
      if (onAccept) {
        onAccept();
      }
      
      // No page reload for mobile or desktop - causes session interruption
      console.log('🍪 Cookie consent accepted - session preserved');
    } catch (error) {
      console.error('🍪 Failed to save consent:', error);
      // Still hide banner and update global state
      globalConsentState.isVisible = false;
      setIsVisible(false);
    }
  };

  const handleDecline = () => {
    try {
      localStorage.setItem('cutmv-cookie-consent', 'declined');
      localStorage.setItem('cutmv-cookie-timestamp', new Date().toISOString());
      
      // Update global state
      globalConsentState.consentValue = 'declined';
      globalConsentState.isVisible = false;
      
      // Mobile-persistent verification
      const verification = localStorage.getItem('cutmv-cookie-consent');
      console.log('🍪 Decline consent saved and verified (global):', verification);
      
      // Immediately hide to prevent re-appearance
      setIsVisible(false);
      
      if (onDecline) {
        onDecline();
      }
    } catch (error) {
      console.error('🍪 Failed to save decline consent:', error);
      // Hide banner and update global state even on failure
      globalConsentState.isVisible = false;
      setIsVisible(false);
    }
  };

  const handleDismiss = () => {
    try {
      // Treat dismiss as "essential only" - allows session cookies
      localStorage.setItem('cutmv-cookie-consent', 'essential-only');
      localStorage.setItem('cutmv-cookie-timestamp', new Date().toISOString());
      
      // Update global state
      globalConsentState.consentValue = 'essential-only';
      globalConsentState.isVisible = false;
      
      // Mobile-persistent verification
      const verification = localStorage.getItem('cutmv-cookie-consent');
      console.log('🍪 Essential-only consent saved and verified (global):', verification);
      
      // Force immediate hide to prevent mobile re-appearance
      setIsVisible(false);
    } catch (error) {
      console.error('🍪 Failed to save essential-only consent:', error);
      // Always hide banner and update global state to prevent perpetual requests
      globalConsentState.isVisible = false;
      setIsVisible(false);
    }
  };

  if (!isVisible) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 bg-white border border-gray-200 rounded-lg shadow-lg max-w-sm">
      <div className="p-4">
        {/* Cookie icon and message */}
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 mt-1">
            <Cookie className="w-5 h-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <div className="text-sm text-gray-700 leading-relaxed">
              <strong className="text-gray-900">We use cookies to improve your experience and analyze site usage.</strong>
              {!showDetails && (
                <button 
                  onClick={() => setShowDetails(true)}
                  className="text-brand-green hover:text-brand-green-dark underline ml-1"
                >
                  Learn more
                </button>
              )}
            </div>
            
            {showDetails && (
              <div className="mt-3 text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Shield className="w-3 h-3 text-green-600" />
                    <span className="font-medium">Essential:</span>
                    <span>Required functionality</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Eye className="w-3 h-3 text-blue-600" />
                    <span className="font-medium">Analytics:</span>
                    <span>PostHog usage tracking</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Cookie className="w-3 h-3 text-purple-600" />
                    <span className="font-medium">Marketing:</span>
                    <span>Resend email tracking</span>
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-gray-200">
                  <a 
                    href="/privacy" 
                    className="text-brand-green hover:text-brand-green-dark underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Privacy Policy
                  </a>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={handleDismiss}
            className="text-gray-400 hover:text-gray-600 p-1 flex-shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          <Button
            onClick={handleAccept}
            size="sm"
            className="bg-brand-green hover:bg-brand-green-dark text-brand-black text-xs py-2 h-auto w-full"
          >
            Accept All
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDecline}
              className="text-xs py-2 h-auto flex-1"
            >
              Essential Only
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper function to check consent status with extended validity
export function getCookieConsent(): 'accepted' | 'declined' | 'essential-only' | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const consent = localStorage.getItem('cutmv-cookie-consent');
    const timestamp = localStorage.getItem('cutmv-cookie-timestamp');
    
    // Validate consent value and check if still valid
    if (consent && ['accepted', 'declined', 'essential-only'].includes(consent)) {
      // Check if consent is older than 1 year
      const consentAge = timestamp ? Date.now() - new Date(timestamp).getTime() : 0;
      const oneYear = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
      
      if (consentAge < oneYear || !timestamp) {
        return consent as 'accepted' | 'declined' | 'essential-only';
      } else {
        // Consent expired - clear it
        localStorage.removeItem('cutmv-cookie-consent');
        localStorage.removeItem('cutmv-cookie-timestamp');
        return null;
      }
    }
    
    return null;
  } catch (error) {
    console.error('🍪 Error reading cookie consent:', error);
    return null;
  }
}

// Helper function to check if analytics should be enabled
export function shouldEnableAnalytics(): boolean {
  return getCookieConsent() === 'accepted';
}