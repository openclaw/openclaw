/*
 * © 2026 Full Digital LLC. All Rights Reserved.
 * CUTMV - Music Video Cut-Down Tool
 * Proprietary software - unauthorized use prohibited
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface OnboardingData {
  name: string;
  marketingConsent: boolean;
}

export function useOnboarding() {
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const completeOnboardingMutation = useMutation({
    mutationFn: async (data: OnboardingData) => {
      const response = await fetch('/api/auth/complete-onboarding', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to complete onboarding');
      }

      return response.json();
    },
    onSuccess: (data) => {
      // Update the user data in cache
      queryClient.setQueryData(['/api/auth/me'], data.user);
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
      
      setIsOnboardingOpen(false);
      
      toast({
        title: "Welcome to CUTMV!",
        description: "Your account setup is complete. You can now start creating professional video content.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Setup Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const openOnboarding = () => setIsOnboardingOpen(true);
  const closeOnboarding = () => setIsOnboardingOpen(false);

  return {
    isOnboardingOpen,
    openOnboarding,
    closeOnboarding,
    completeOnboarding: completeOnboardingMutation.mutate,
    isCompleting: completeOnboardingMutation.isPending,
  };
}