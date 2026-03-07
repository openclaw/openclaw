import { useEffect } from 'react';
import { useLocation } from 'wouter';

/**
 * ScrollToTop component that automatically scrolls to the top of the page
 * whenever the route changes. This ensures consistent user experience
 * across all page navigation in the dashboard.
 */
export default function ScrollToTop() {
  const [location] = useLocation();

  useEffect(() => {
    // Scroll to top immediately when location changes
    window.scrollTo(0, 0);
  }, [location]);

  return null;
}