-- CUTMV Supabase Database Schema
-- Run this SQL in your Supabase SQL Editor to create the required tables

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    referral_code TEXT UNIQUE NOT NULL,
    referred_by TEXT,
    credits INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Referrals table
CREATE TABLE IF NOT EXISTS referrals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
    referee_email TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Credit transactions table
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    type TEXT CHECK (type IN ('earned', 'spent', 'adjustment')) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Exports table (for tracking user exports)
CREATE TABLE IF NOT EXISTS exports (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    video_name TEXT NOT NULL,
    export_type TEXT NOT NULL,
    file_path TEXT,
    status TEXT DEFAULT 'completed',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '29 days')
);

-- Function to increment credits atomically
CREATE OR REPLACE FUNCTION increment_credits(user_id UUID, credit_amount INTEGER)
RETURNS INTEGER AS $$
DECLARE
    new_balance INTEGER;
BEGIN
    UPDATE users 
    SET credits = credits + credit_amount 
    WHERE id = user_id 
    RETURNING credits INTO new_balance;
    
    RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_exports_user_id ON exports(user_id);

-- Row Level Security (RLS) policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

-- Public read access for referral code lookups
CREATE POLICY "Public read access for referral codes" ON users
    FOR SELECT USING (true);

-- Users can only read their own data
CREATE POLICY "Users can read own data" ON users
    FOR ALL USING (email = current_setting('request.jwt.claims', true)::json->>'email');

-- Allow inserts for new user registration
CREATE POLICY "Allow user registration" ON users
    FOR INSERT WITH CHECK (true);

-- Allow referral creation
CREATE POLICY "Allow referral creation" ON referrals
    FOR INSERT WITH CHECK (true);

-- Users can read their own referrals
CREATE POLICY "Users can read own referrals" ON referrals
    FOR SELECT USING (
        referrer_id IN (SELECT id FROM users WHERE email = current_setting('request.jwt.claims', true)::json->>'email')
    );

-- Users can read their own credit transactions
CREATE POLICY "Users can read own credit transactions" ON credit_transactions
    FOR SELECT USING (
        user_id IN (SELECT id FROM users WHERE email = current_setting('request.jwt.claims', true)::json->>'email')
    );

-- Allow credit transaction creation
CREATE POLICY "Allow credit transaction creation" ON credit_transactions
    FOR INSERT WITH CHECK (true);

-- Users can read their own exports
CREATE POLICY "Users can read own exports" ON exports
    FOR SELECT USING (
        user_id IN (SELECT id FROM users WHERE email = current_setting('request.jwt.claims', true)::json->>'email')
    );

-- Allow export creation
CREATE POLICY "Allow export creation" ON exports
    FOR INSERT WITH CHECK (true);