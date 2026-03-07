/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Favicon Provider Component
 * Dynamically manages favicon and meta tags for all pages
 */

import { useEffect } from 'react';

interface FaviconProviderProps {
  children: React.ReactNode;
  title?: string;
  description?: string;
}

export function FaviconProvider({ 
  children, 
  title = "CUTMV - AI-Powered Video Creation Platform | Full Digital",
  description = "Transform your music videos into professional clips, GIFs, thumbnails, and Spotify Canvas with CUTMV's AI-powered platform. Commercial-quality exports for creators."
}: FaviconProviderProps) {
  
  useEffect(() => {
    // Update document title
    document.title = title;
    
    // Update meta description
    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription) {
      metaDescription.setAttribute('content', description);
    }
    
    // Update Open Graph meta tags
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      ogTitle.setAttribute('content', title);
    }
    
    const ogDescription = document.querySelector('meta[property="og:description"]');
    if (ogDescription) {
      ogDescription.setAttribute('content', description);
    }
    
    // Update Twitter meta tags
    const twitterTitle = document.querySelector('meta[property="twitter:title"]');
    if (twitterTitle) {
      twitterTitle.setAttribute('content', title);
    }
    
    const twitterDescription = document.querySelector('meta[property="twitter:description"]');
    if (twitterDescription) {
      twitterDescription.setAttribute('content', description);
    }
    
    // Ensure favicon is properly loaded
    const favicon = document.querySelector('link[rel="shortcut icon"]') as HTMLLinkElement;
    if (favicon) {
      // Force favicon refresh
      favicon.href = '/favicon.ico?' + new Date().getTime();
    }
    
  }, [title, description]);

  return <>{children}</>;
}

export default FaviconProvider;