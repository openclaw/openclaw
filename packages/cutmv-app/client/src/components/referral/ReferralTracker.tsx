/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Referral Tracker Component
 * Handles referral parameter detection and tracking
 */

import { useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { nanoid } from 'nanoid';

export function ReferralTracker() {
  const { toast } = useToast();

  useEffect(() => {
    const trackReferral = async () => {
      try {
        // Check for referral code in URL
        const urlParams = new URLSearchParams(window.location.search);
        const referralCode = urlParams.get('ref');
        
        if (!referralCode) {return;}

        // Generate or get session ID
        let sessionId = localStorage.getItem('cutmv-session-id');
        if (!sessionId) {
          sessionId = nanoid();
          localStorage.setItem('cutmv-session-id', sessionId);
        }

        // Check if we've already tracked this referral
        const trackedReferral = localStorage.getItem(`cutmv-tracked-${referralCode}`);
        if (trackedReferral) {return;}

        // Track the referral visit
        const response = await fetch('/api/referral/track', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            referralCode,
            sessionId,
            landingPage: window.location.pathname,
          }),
        });

        const result = await response.json();
        
        if (result.success) {
          // Store tracking to prevent duplicates
          localStorage.setItem(`cutmv-tracked-${referralCode}`, 'true');
          localStorage.setItem('cutmv-referral-code', referralCode);
          
          // Show welcome message
          toast({
            title: "Welcome!",
            description: "You've been referred to CUTMV. Sign up to get started with exclusive benefits!",
            duration: 5000,
          });

          // Clean up URL without refreshing page
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (error) {
        console.error('Error tracking referral:', error);
      }
    };

    trackReferral();
  }, [toast]);

  // This component doesn't render anything visible
  return null;
}

// Hook to handle referral signup process
export function useReferralSignup() {
  const processReferralSignup = async () => {
    try {
      const sessionId = localStorage.getItem('cutmv-session-id');
      const referralCode = localStorage.getItem('cutmv-referral-code');
      
      if (!sessionId || !referralCode) {return null;}

      const response = await fetch('/api/referral/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ sessionId }),
      });

      const result = await response.json();
      
      if (result.success && result.rewards) {
        // Clear stored referral data
        localStorage.removeItem('cutmv-referral-code');
        
        return result.rewards;
      }
      
      return null;
    } catch (error) {
      console.error('Error processing referral signup:', error);
      return null;
    }
  };

  return { processReferralSignup };
}

// Hook to handle first export bonus
export function useFirstExportBonus() {
  const processFirstExportBonus = async (exportId: string) => {
    try {
      const response = await fetch('/api/referral/first-export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ exportId }),
      });

      const result = await response.json();
      
      return result.success;
    } catch (error) {
      console.error('Error processing first export bonus:', error);
      return false;
    }
  };

  return { processFirstExportBonus };
}