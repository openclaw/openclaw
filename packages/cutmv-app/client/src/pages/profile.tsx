import { useState, useEffect } from "react";
import { User, CreditCard, Settings, Save, Eye, EyeOff, Trash2, Shield, Copy, Users, Gift, Sparkles, Crown, Zap, ExternalLink } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth, AuthGuard } from "@/components/AuthGuard";
import FaviconProvider from "@/components/FaviconProvider";
import DashboardLayout from "@/components/DashboardLayout";

interface UserProfile {
  id: string;
  email: string;
  name?: string;
  marketingConsent?: boolean;
  referralCode?: string;
  referralCount?: number;
  credits?: number;
  createdAt: string;
}

interface PaymentMethodInfo {
  paymentMethod?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  };
}

interface SubscriptionStatus {
  hasActiveSubscription: boolean;
  subscriptionId?: string;
  status?: string;
  currentPeriodEnd?: string;
  plan?: {
    id: string;
    name: string;
    monthlyCredits: number;
    price: number;
  };
  cancelAtPeriodEnd?: boolean;
}

export default function ProfilePage() {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [paymentMethodInfo, setPaymentMethodInfo] = useState<PaymentMethodInfo | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const { toast } = useToast();

  // Get active tab from URL parameter
  const getActiveTab = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const tab = urlParams.get('tab');
    return tab && ['profile', 'payment', 'security'].includes(tab) ? tab : 'profile';
  };

  const [activeTab, setActiveTab] = useState(getActiveTab());

  // Form states
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);

  useEffect(() => {
    if (user) {
      // Use the user data from AuthGuard instead of fetching again
      setProfile(user);
      setName(user.name || "");
      setEmail(user.email || "");
      setMarketingConsent(user.marketingConsent || false);
      fetchPaymentMethodInfo();
      fetchSubscriptionStatus();
    }
  }, [user]);

  // Update active tab when URL changes
  useEffect(() => {
    setActiveTab(getActiveTab());
  }, [location]);

  const fetchProfile = async () => {
    try {
      const response = await apiRequest("GET", "/api/auth/me");
      const data = await response.json();
      // Handle the nested user structure from auth endpoint
      const profileData = data.user || data;
      setProfile(profileData);
      setName(profileData.name || "");
      setEmail(profileData.email || "");
      setMarketingConsent(profileData.marketingConsent || false);
    } catch (error) {
      console.error("Failed to fetch profile:", error);
      toast({
        title: "Error",
        description: "Failed to load profile information.",
        variant: "destructive",
      });
    }
  };

  const fetchPaymentMethodInfo = async () => {
    try {
      const response = await apiRequest("GET", "/api/billing/payment-methods");
      const data = await response.json();

      // Format the payment method info for pay-per-use model
      if (data.paymentMethods && data.paymentMethods.length > 0) {
        const paymentMethod = data.paymentMethods[0]; // Use first payment method
        setPaymentMethodInfo({
          paymentMethod: {
            brand: paymentMethod.brand,
            last4: paymentMethod.last4,
            expMonth: paymentMethod.expMonth,
            expYear: paymentMethod.expYear,
          }
        });
      } else {
        setPaymentMethodInfo(null);
      }
    } catch (error) {
      console.error("Failed to fetch payment method info:", error);
      setPaymentMethodInfo(null);
    }
  };

  const fetchSubscriptionStatus = async () => {
    try {
      const response = await fetch('/api/subscription/status', {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        setSubscriptionStatus(data);
      } else {
        setSubscriptionStatus({ hasActiveSubscription: false });
      }
    } catch (error) {
      console.error("Failed to fetch subscription status:", error);
      setSubscriptionStatus({ hasActiveSubscription: false });
    }
  };

  const updateProfile = async () => {
    if (!name.trim()) {
      toast({
        title: "Validation Error",
        description: "Name is required.",
        variant: "destructive",
      });
      return;
    }

    setIsUpdating(true);
    try {
      const response = await apiRequest("PATCH", "/api/auth/profile", {
        name: name.trim(),
        marketingConsent,
      });

      if (response.ok) {
        const updatedProfile = await response.json();
        setProfile(updatedProfile);
        toast({
          title: "Profile Updated",
          description: "Your profile has been updated successfully.",
        });
      } else {
        throw new Error("Failed to update profile");
      }
    } catch (error) {
      console.error("Profile update error:", error);
      toast({
        title: "Update Failed",
        description: "Failed to update profile. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const removePaymentMethod = async () => {
    try {
      const response = await apiRequest("DELETE", "/api/billing/payment-method");
      if (response.ok) {
        await fetchPaymentMethodInfo();
        toast({
          title: "Payment Method Removed",
          description: "Your payment method has been removed successfully.",
        });
      } else {
        throw new Error("Failed to remove payment method");
      }
    } catch (error) {
      console.error("Remove payment method error:", error);
      toast({
        title: "Removal Failed",
        description: "Failed to remove payment method. Please try again.",
        variant: "destructive",
      });
    }
  };

  const deleteAccount = async () => {
    if (deleteConfirmText !== "DELETE") {
      toast({
        title: "Confirmation Required",
        description: "Please type 'DELETE' to confirm account deletion.",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await apiRequest("DELETE", "/api/auth/profile");
      if (response.ok) {
        toast({
          title: "Account Deleted",
          description: "Your account has been permanently deleted.",
        });
        // Redirect to home after deletion
        window.location.href = "/";
      } else {
        throw new Error("Failed to delete account");
      }
    } catch (error) {
      console.error("Delete account error:", error);
      toast({
        title: "Deletion Failed",
        description: "Failed to delete account. Please try again.",
        variant: "destructive",
      });
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-green-600 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-600">Loading profile...</p>
        </div>
      </div>
    );
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
      window.location.href = '/';
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <AuthGuard>
      <FaviconProvider 
        title="Profile & Settings - CUTMV | Full Digital"
        description="Manage your CUTMV account settings, payment method, and referral program. Professional video processing platform by Full Digital."
      >
        <DashboardLayout currentUser={user} onLogout={handleLogout}>
        <div className="p-4 md:p-6">
          <div className="mb-6 md:mb-8">
            <div className="flex items-center justify-between mb-4">
              <div className="pt-12 md:pt-0">
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Profile Settings</h1>
                <p className="text-sm md:text-base text-gray-600">Manage your account, payment method, and preferences</p>
              </div>

            </div>
          </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 gap-1 md:gap-2">
            <TabsTrigger value="profile" className="flex items-center gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-4">
              <User className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Profile</span>
              <span className="sm:hidden">Info</span>
            </TabsTrigger>
            <TabsTrigger value="payment" className="flex items-center gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-4">
              <CreditCard className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Payment</span>
              <span className="sm:hidden">Pay</span>
            </TabsTrigger>
            <TabsTrigger value="security" className="flex items-center gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-4">
              <Shield className="w-3 h-3 md:w-4 md:h-4" />
              <span className="hidden sm:inline">Security</span>
              <span className="sm:hidden">Sec</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Profile Information</CardTitle>
                <CardDescription>
                  Update your personal information and preferences
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Full Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Enter your full name"
                    />
                  </div>
                  <div>
                    <Label htmlFor="email">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      disabled
                      className="bg-gray-50"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Email cannot be changed. Contact support if needed.
                    </p>
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="marketing"
                    checked={marketingConsent}
                    onChange={(e) => setMarketingConsent(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <Label htmlFor="marketing" className="text-sm">
                    I'd like to receive updates about new features and promotions
                  </Label>
                </div>

                <div className="flex justify-end">
                  <Button
                    onClick={updateProfile}
                    disabled={isUpdating}
                    className="text-white"
                    style={{ backgroundColor: 'hsl(85, 70%, 55%)' }}
                  >
                    <Save className="w-4 h-4 mr-2" />
                    {isUpdating ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {profile && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <User className="w-5 h-5" />
                      Personal Information
                    </CardTitle>
                    <CardDescription>Your account details and information</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <Label className="text-sm font-medium text-gray-500">Email Address</Label>
                        <p className="mt-1 text-sm">{profile.email}</p>
                      </div>
                      <div>
                        <Label className="text-sm font-medium text-gray-500">Account ID</Label>
                        <p className="mt-1 text-sm font-mono">#{profile.id.slice(0, 8).toUpperCase()}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Gift className="w-5 h-5" />
                      Referral Program
                    </CardTitle>
                    <CardDescription>Share CUTMV with others and grow your network</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <h4 className="font-medium text-gray-900 mb-3">Your Referral Performance</h4>
                      <div className="space-y-2">
                        <div>
                          <p className="text-sm text-gray-500">Total Referred Users</p>
                          <p className="text-2xl font-bold text-green-600">{profile.referralCount || 0}</p>
                        </div>
                      </div>
                    </div>

                    <div>
                      <Label className="text-sm font-medium text-gray-900">Your Referral Code</Label>
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          value={profile.referralCode || 'Generating...'}
                          readOnly
                          className="font-mono bg-gray-50"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            navigator.clipboard.writeText(profile.referralCode || '');
                            toast({
                              title: "Copied!",
                              description: "Referral code copied to clipboard.",
                            });
                          }}
                          disabled={!profile.referralCode}
                        >
                          <Copy className="w-4 h-4" />
                          Copy Code
                        </Button>
                      </div>
                    </div>

                    <div>
                      <Label className="text-sm font-medium text-gray-900">Shareable Referral Link</Label>
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          value={profile.referralCode ? `https://cutmv.fulldigitalll.com/referral/${profile.referralCode}` : 'Generating...'}
                          readOnly
                          className="text-xs bg-gray-50"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const link = `https://cutmv.fulldigitalll.com/referral/${profile.referralCode}`;
                            navigator.clipboard.writeText(link);
                            toast({
                              title: "Copied!",
                              description: "Referral link copied to clipboard.",
                            });
                          }}
                          disabled={!profile.referralCode}
                        >
                          <Copy className="w-4 h-4" />
                          Copy Link
                        </Button>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Share this link with others to invite them to join CUTMV.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="payment" className="space-y-6">
            {/* Subscription Status Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-brand-green" />
                  Subscription
                </CardTitle>
                <CardDescription>
                  Manage your CUTMV subscription and save 50% on all processing
                </CardDescription>
              </CardHeader>
              <CardContent>
                {subscriptionStatus?.hasActiveSubscription ? (
                  <div className="space-y-4">
                    <div className="bg-green-50 border border-green-200 p-4 rounded-lg">
                      <div className="flex items-center gap-3 mb-3">
                        {subscriptionStatus.plan?.id === 'enterprise' ? (
                          <Crown className="w-6 h-6 text-yellow-500" />
                        ) : subscriptionStatus.plan?.id === 'pro' ? (
                          <Sparkles className="w-6 h-6 text-brand-green" />
                        ) : (
                          <Zap className="w-6 h-6 text-blue-500" />
                        )}
                        <div>
                          <p className="font-semibold text-gray-900">
                            {subscriptionStatus.plan?.name} Plan
                          </p>
                          <p className="text-sm text-gray-600">
                            ${subscriptionStatus.plan?.price}/month • {subscriptionStatus.plan?.monthlyCredits?.toLocaleString()} credits/month
                          </p>
                        </div>
                      </div>

                      <div className="text-sm text-gray-600 space-y-1">
                        {subscriptionStatus.cancelAtPeriodEnd ? (
                          <p className="text-orange-600 font-medium">
                            Cancels on {subscriptionStatus.currentPeriodEnd ? new Date(subscriptionStatus.currentPeriodEnd).toLocaleDateString() : 'N/A'}
                          </p>
                        ) : (
                          <p>
                            Renews: {subscriptionStatus.currentPeriodEnd ? new Date(subscriptionStatus.currentPeriodEnd).toLocaleDateString() : 'N/A'}
                          </p>
                        )}
                        <p className="text-green-600 font-medium">
                          50% off all video processing
                        </p>
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      onClick={() => window.location.href = '/app/subscription'}
                      className="w-full"
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      Manage Subscription
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <Sparkles className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                    <h4 className="font-medium text-gray-900 mb-2">No Active Subscription</h4>
                    <p className="text-sm text-gray-500 mb-4">
                      Subscribe to save 50% on all video processing and get monthly credits
                    </p>
                    <Button
                      className="text-black"
                      style={{ backgroundColor: 'hsl(85, 70%, 55%)' }}
                      onClick={() => window.location.href = '/app/subscription'}
                    >
                      <Sparkles className="w-4 h-4 mr-2" />
                      View Subscription Plans
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Payment Method Card */}
            <Card>
              <CardHeader>
                <CardTitle>Payment Method</CardTitle>
                <CardDescription>
                  Manage your stored payment method for subscriptions and purchases
                </CardDescription>
              </CardHeader>
              <CardContent>
                {paymentMethodInfo?.paymentMethod ? (
                  <div className="space-y-4">
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <h4 className="font-medium text-gray-900 mb-3">Stored Payment Method</h4>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-6 bg-gray-300 rounded flex items-center justify-center">
                          <span className="text-xs font-bold text-gray-600">
                            {paymentMethodInfo.paymentMethod.brand.toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium">**** **** **** {paymentMethodInfo.paymentMethod.last4}</p>
                          <p className="text-sm text-gray-500">
                            Expires {paymentMethodInfo.paymentMethod.expMonth}/{paymentMethodInfo.paymentMethod.expYear}
                          </p>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex gap-3">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => window.location.href = '/app/add-payment-method'}
                      >
                        Update Payment Method
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={removePaymentMethod}
                      >
                        Remove Payment Method
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <CreditCard className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                    <h4 className="font-medium text-gray-900 mb-2">No Stored Payment Method</h4>
                    <p className="text-sm text-gray-500 mb-4">
                      Add a payment method for faster checkout when processing videos
                    </p>
                    <Button 
                      className="text-white"
                      style={{ backgroundColor: 'hsl(85, 70%, 55%)' }}
                      onClick={() => window.location.href = '/app/add-payment-method'}
                    >
                      Add Payment Method
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Account Security</CardTitle>
                <CardDescription>
                  Manage your account security and data
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">Authentication</h4>
                  <p className="text-sm text-gray-600 mb-3">
                    CUTMV uses magic link authentication for enhanced security. 
                    Your email serves as your secure login method.
                  </p>
                  <Alert>
                    <Shield className="w-4 h-4" />
                    <AlertDescription>
                      No password required - we send secure login links to your email.
                    </AlertDescription>
                  </Alert>
                </div>

                <div className="border-t pt-6">
                  <h4 className="font-medium text-red-600 mb-2">Danger Zone</h4>
                  <p className="text-sm text-gray-600 mb-4">
                    Permanently delete your account and all associated data. This action cannot be undone.
                  </p>
                  
                  {!showDeleteConfirm ? (
                    <Button
                      variant="outline"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="text-red-600 border-red-300 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete Account
                    </Button>
                  ) : (
                    <div className="space-y-4 p-4 border-2 border-red-200 rounded-lg bg-red-50">
                      <div>
                        <Label htmlFor="deleteConfirm">
                          Type "DELETE" to confirm account deletion:
                        </Label>
                        <Input
                          id="deleteConfirm"
                          value={deleteConfirmText}
                          onChange={(e) => setDeleteConfirmText(e.target.value)}
                          placeholder="Type DELETE here"
                          className="mt-1"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={deleteAccount}
                          disabled={deleteConfirmText !== "DELETE"}
                          className="bg-red-600 text-white hover:bg-red-700"
                        >
                          Permanently Delete Account
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setShowDeleteConfirm(false);
                            setDeleteConfirmText("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        </div>
      </DashboardLayout>
    </FaviconProvider>
    </AuthGuard>
  );
}