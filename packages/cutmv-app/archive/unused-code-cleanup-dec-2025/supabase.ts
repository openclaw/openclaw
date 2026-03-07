import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('⚠️ Supabase configuration missing - falling back to local storage');
  console.log('Debug - SUPABASE_URL configured:', !!supabaseUrl);
  console.log('Debug - SUPABASE_ANON_KEY configured:', !!supabaseKey);
} else {
  // Validate Supabase URL format
  try {
    const url = new URL(supabaseUrl);
    if (!url.hostname.includes('supabase.co')) {
      console.warn('⚠️ SUPABASE_URL format may be invalid');
    }
  } catch {
    console.warn('⚠️ SUPABASE_URL is not a valid URL');
  }
  
  console.log('✅ Supabase integration initialized');
}

export const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export interface SupabaseUser {
  id: string;
  email: string;
  referral_code: string;
  referred_by?: string;
  credits: number;
  created_at: string;
}

export interface SupabaseReferral {
  id: string;
  referrer_id: string;
  referee_email: string;
  created_at: string;
}

export interface SupabaseCreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  type: 'earned' | 'spent' | 'adjustment';
  description: string;
  created_at: string;
}

/**
 * Supabase service for user and referral management
 */
export class SupabaseService {
  constructor(private client = supabase) {}

  /**
   * Create a new user in Supabase
   */
  async createUser(email: string, referredBy?: string): Promise<SupabaseUser | null> {
    if (!this.client) return null;

    try {
      // Generate unique referral code
      const referralCode = this.generateReferralCode(email);

      const { data, error } = await this.client
        .from('users')
        .insert({
          email,
          referral_code: referralCode,
          referred_by: referredBy,
          credits: 0
        })
        .select()
        .single();

      if (error) {
        console.error('Supabase create user error:', error);
        return null;
      }

      console.log(`✅ Supabase: Created user ${email} with referral code ${referralCode}`);

      // If user was referred, process the referral
      if (referredBy) {
        await this.processReferral(referredBy, email);
      }

      return data;
    } catch (error) {
      console.error('Supabase create user error:', error);
      return null;
    }
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email: string): Promise<SupabaseUser | null> {
    if (!this.client) return null;

    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('email', email)
        .single();

      if (error) {
        if (error.code !== 'PGRST116') { // Not found error
          console.error('Supabase get user error:', error);
        }
        return null;
      }

      return data;
    } catch (error) {
      console.error('Supabase get user error:', error);
      return null;
    }
  }

  /**
   * Get user by referral code
   */
  async getUserByReferralCode(referralCode: string): Promise<SupabaseUser | null> {
    if (!this.client) return null;

    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('referral_code', referralCode)
        .single();

      if (error) {
        if (error.code !== 'PGRST116') {
          console.error('Supabase get user by referral code error:', error);
        }
        return null;
      }

      return data;
    } catch (error) {
      console.error('Supabase get user by referral code error:', error);
      return null;
    }
  }

  /**
   * Process a referral (give credit to referrer, log referral)
   */
  async processReferral(referralCode: string, refereeEmail: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      // Get referrer by referral code
      const referrer = await this.getUserByReferralCode(referralCode);
      if (!referrer) {
        console.warn(`⚠️ Referral code ${referralCode} not found`);
        return false;
      }

      // Award 1 credit to referrer
      await this.addCredits(referrer.id, 1, 'earned', `Referral signup: ${refereeEmail}`);

      // Log the referral
      const { error: referralError } = await this.client
        .from('referrals')
        .insert({
          referrer_id: referrer.id,
          referee_email: refereeEmail
        });

      if (referralError) {
        console.error('Supabase referral logging error:', referralError);
        return false;
      }

      console.log(`✅ Supabase: Processed referral ${referralCode} → ${refereeEmail}, awarded 1 credit to ${referrer.email}`);
      return true;
    } catch (error) {
      console.error('Supabase process referral error:', error);
      return false;
    }
  }

  /**
   * Add or subtract credits from user
   */
  async addCredits(userId: string, amount: number, type: 'earned' | 'spent' | 'adjustment', description: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      // Update user credits
      const { error: updateError } = await this.client
        .from('users')
        .update({ 
          credits: this.client.rpc('increment_credits', { user_id: userId, credit_amount: amount })
        })
        .eq('id', userId);

      if (updateError) {
        console.error('Supabase update credits error:', updateError);
        return false;
      }

      // Log the transaction
      const { error: transactionError } = await this.client
        .from('credit_transactions')
        .insert({
          user_id: userId,
          amount,
          type,
          description
        });

      if (transactionError) {
        console.error('Supabase credit transaction error:', transactionError);
        return false;
      }

      console.log(`✅ Supabase: ${amount > 0 ? 'Added' : 'Deducted'} ${Math.abs(amount)} credits for user ${userId}: ${description}`);
      return true;
    } catch (error) {
      console.error('Supabase add credits error:', error);
      return false;
    }
  }

  /**
   * Get user's credit balance
   */
  async getUserCredits(email: string): Promise<number> {
    if (!this.client) return 0;

    try {
      const user = await this.getUserByEmail(email);
      return user?.credits || 0;
    } catch (error) {
      console.error('Supabase get user credits error:', error);
      return 0;
    }
  }

  /**
   * Get user's referral statistics
   */
  async getUserReferralStats(email: string): Promise<{
    referralCode: string;
    totalReferrals: number;
    totalCreditsEarned: number;
    recentReferrals: SupabaseReferral[];
  } | null> {
    if (!this.client) return null;

    try {
      const user = await this.getUserByEmail(email);
      if (!user) return null;

      // Get referral count
      const { count: referralCount } = await this.client
        .from('referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referrer_id', user.id);

      // Get recent referrals
      const { data: recentReferrals } = await this.client
        .from('referrals')
        .select('*')
        .eq('referrer_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);

      // Get total credits earned from referrals
      const { data: creditTransactions } = await this.client
        .from('credit_transactions')
        .select('amount')
        .eq('user_id', user.id)
        .eq('type', 'earned')
        .like('description', 'Referral signup:%');

      const totalCreditsEarned = creditTransactions?.reduce((sum, tx) => sum + tx.amount, 0) || 0;

      return {
        referralCode: user.referral_code,
        totalReferrals: referralCount || 0,
        totalCreditsEarned,
        recentReferrals: recentReferrals || []
      };
    } catch (error) {
      console.error('Supabase get referral stats error:', error);
      return null;
    }
  }

  /**
   * Get admin analytics
   */
  async getAdminAnalytics(): Promise<{
    totalUsers: number;
    totalReferrals: number;
    totalCreditsIssued: number;
    totalCreditsSpent: number;
    topReferrers: Array<{ email: string; referralCount: number; creditsEarned: number }>;
  } | null> {
    if (!this.client) return null;

    try {
      // Total users
      const { count: totalUsers } = await this.client
        .from('users')
        .select('*', { count: 'exact', head: true });

      // Total referrals
      const { count: totalReferrals } = await this.client
        .from('referrals')
        .select('*', { count: 'exact', head: true });

      // Credit statistics
      const { data: creditStats } = await this.client
        .from('credit_transactions')
        .select('amount, type');

      const totalCreditsIssued = creditStats?.filter(tx => tx.type === 'earned').reduce((sum, tx) => sum + tx.amount, 0) || 0;
      const totalCreditsSpent = creditStats?.filter(tx => tx.type === 'spent').reduce((sum, tx) => sum + Math.abs(tx.amount), 0) || 0;

      // Top referrers
      const { data: topReferrersData } = await this.client
        .from('users')
        .select(`
          email,
          referrals:referrals(count),
          credit_transactions:credit_transactions(amount)
        `)
        .not('referrals', 'is', null)
        .limit(10);

      const topReferrers = topReferrersData?.map(user => ({
        email: user.email,
        referralCount: user.referrals?.length || 0,
        creditsEarned: user.credit_transactions?.filter((tx: any) => tx.amount > 0).reduce((sum: number, tx: any) => sum + tx.amount, 0) || 0
      })).sort((a, b) => b.referralCount - a.referralCount) || [];

      return {
        totalUsers: totalUsers || 0,
        totalReferrals: totalReferrals || 0,
        totalCreditsIssued,
        totalCreditsSpent,
        topReferrers
      };
    } catch (error) {
      console.error('Supabase admin analytics error:', error);
      return null;
    }
  }

  /**
   * Generate a unique referral code based on email
   */
  private generateReferralCode(email: string): string {
    const username = email.split('@')[0];
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    return `${username}_${randomSuffix}`.toUpperCase();
  }

  /**
   * Check if Supabase is available
   */
  isAvailable(): boolean {
    return this.client !== null;
  }
}

export const supabaseService = new SupabaseService();