import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import OnboardingModal from "@/components/OnboardingModal";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useEffect } from "react";

interface AuthGuardProps {
  children: React.ReactNode;
}

interface AuthUser {
  id: string;
  email: string;
  name?: string;
  marketingConsent?: boolean;
  onboardingCompleted?: boolean;
  referralCode?: string;
  referredBy?: string;
  credits?: number;
  referralCount?: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: string;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const [, setLocation] = useLocation();
  const { isOnboardingOpen, openOnboarding, completeOnboarding, isCompleting } = useOnboarding();

  const { data: user, isLoading, error } = useQuery({
    queryKey: ['/api/auth/me'],
    queryFn: async () => {
      console.log('🔍 AuthGuard: Checking authentication status...');
      const response = await apiRequest("GET", "/api/auth/me");
      console.log('🔍 AuthGuard: Auth response status:', response.status);
      
      if (response.status === 401) {
        console.log('❌ AuthGuard: Not authenticated - redirecting to login');
        // Clear any stale session data
        localStorage.removeItem('cutmv-auth-timestamp');
        throw new Error('Not authenticated');
      }
      
      console.log('✅ AuthGuard: User authenticated successfully');
      // Update last auth check timestamp
      localStorage.setItem('cutmv-auth-timestamp', Date.now().toString());
      return response.json() as Promise<{ user: AuthUser; supabaseData?: any }>;
    },
    retry: (failureCount, error) => {
      console.log('🔄 AuthGuard: Query retry attempt', failureCount, error.message);
      return failureCount < 2; // Retry twice
    },
    refetchInterval: 1000 * 60 * 15, // Check every 15 minutes
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    staleTime: 1000 * 60 * 10 // 10 minutes stale time
  });

  // Check if user needs onboarding after authentication
  useEffect(() => {
    if (user?.user && !user.user.onboardingCompleted && !isOnboardingOpen) {
      openOnboarding();
    }
  }, [user?.user, isOnboardingOpen, openOnboarding]);

  // Session timeout check - logout if session is stale
  useEffect(() => {
    const checkSessionTimeout = () => {
      const lastAuthCheck = localStorage.getItem('cutmv-auth-timestamp');
      if (lastAuthCheck) {
        const timeSinceLastCheck = Date.now() - parseInt(lastAuthCheck);
        const eightHours = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
        
        if (timeSinceLastCheck > eightHours) {
          // Session expired, force logout
          localStorage.removeItem('cutmv-auth-timestamp');
          fetch('/api/auth/logout', { 
            method: 'POST', 
            credentials: 'include' 
          }).finally(() => {
            window.location.href = '/login';
          });
          return;
        }
      }
    };

    // Don't automatically clear sessions - let the auth query handle it
    checkSessionTimeout();
    
    // Check every 5 minutes
    const interval = setInterval(checkSessionTimeout, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-green-600" />
          <p className="text-gray-600">Verifying authentication...</p>
        </div>
      </div>
    );
  }

  if (error || !user) {
    console.log('❌ AuthGuard: Authentication failed, redirecting to login', {
      error: error?.message,
      hasUser: !!user,
      url: window.location.href
    });
    // Redirect to login page
    setLocation("/login");
    return null;
  }

  const handleOnboardingComplete = async (data: { name: string; marketingConsent: boolean }) => {
    await completeOnboarding(data);
    // Force reload the page to refresh authentication state and show dashboard
    window.location.reload();
  };

  return (
    <>
      {children}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onComplete={handleOnboardingComplete}
        userEmail={user.user.email}
      />
    </>
  );
}

export function useAuth() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['/api/auth/me'],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/auth/me");
      if (response.status === 401) {
        throw new Error('Not authenticated');
      }
      return response.json() as Promise<{ user: AuthUser; supabaseData?: any }>;
    },
    retry: false
  });

  return {
    user: data?.user || null,
    supabaseData: data?.supabaseData || null,
    isLoading,
    isAuthenticated: !!data?.user && !error
  };
}