/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Silent Authentication Hook
 * Handles seamless auth validation and redirects
 */

import { useEffect } from 'react';

export function useAuthCheck() {
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/me', {
          credentials: 'include'
        });
        
        if (!response.ok) {
          // Add delay to prevent race conditions with session setup
          console.log('Authentication check failed, waiting before redirect...');
          setTimeout(() => {
            console.log('Authentication expired, redirecting to login...');
            window.location.href = '/login?message=Please log in to continue';
          }, 1000); // 1 second delay
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        // Add delay for network errors too
        setTimeout(() => {
          window.location.href = '/login?message=Connection error. Please try again.';
        }, 1000);
      }
    };

    // Add initial delay to allow session cookie to be set after magic link redirect
    const initialTimeout = setTimeout(() => {
      checkAuth();
      const interval = setInterval(checkAuth, 5 * 60 * 1000); // Every 5 minutes

      return () => clearInterval(interval);
    }, 2000); // 2 second initial delay

    return () => clearTimeout(initialTimeout);
  }, []);
}