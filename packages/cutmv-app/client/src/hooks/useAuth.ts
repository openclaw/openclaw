/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Authentication Hook
 * Manage user authentication state
 */

import { useState, useEffect } from 'react';
import { useReferralSignup } from '@/components/referral/ReferralTracker';
import type { User } from '@shared/schema';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const { processReferralSignup } = useReferralSignup();

  useEffect(() => {
    checkAuthStatus();
    
    // Session timeout check - logout if session is stale
    const checkSessionTimeout = () => {
      const lastAuthCheck = localStorage.getItem('cutmv-auth-timestamp');
      if (lastAuthCheck && isAuthenticated) {
        const timeSinceLastCheck = Date.now() - parseInt(lastAuthCheck);
        const eightHours = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
        
        if (timeSinceLastCheck > eightHours) {
          // Session expired, force logout
          localStorage.removeItem('cutmv-auth-timestamp');
          setUser(null);
          setIsAuthenticated(false);
          window.location.href = '/login';
          return;
        }
      }
    };
    
    // Check every 5 minutes for session timeout
    const interval = setInterval(checkSessionTimeout, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include'
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setIsAuthenticated(true);
        
        // Update last auth check timestamp
        localStorage.setItem('cutmv-auth-timestamp', Date.now().toString());
        
        // Process referral signup if this is a new authentication
        try {
          const referralRewards = await processReferralSignup();
          if (referralRewards) {
            console.log('✅ Referral signup processed:', referralRewards);
          }
        } catch (error) {
          console.error('Error processing referral signup:', error);
        }
      } else {
        // Clear any stale session data on auth failure
        localStorage.removeItem('cutmv-auth-timestamp');
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Auth check error:', error);
      localStorage.removeItem('cutmv-auth-timestamp');
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      // Clear client-side session data
      localStorage.removeItem('cutmv-auth-timestamp');
      
      // Call server logout
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      setIsAuthenticated(false);
      // Always redirect to login after logout
      window.location.href = '/login';
    }
  };

  return {
    user,
    isAuthenticated,
    isLoading,
    checkAuthStatus,
    logout
  };
}