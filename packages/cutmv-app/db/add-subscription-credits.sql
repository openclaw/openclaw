-- Migration: Add subscription credits tracking to users table
-- Run this on your Neon/PostgreSQL database

ALTER TABLE users
ADD COLUMN IF NOT EXISTS subscription_credits INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS subscription_credit_reset_date TIMESTAMP;

-- Update comment on credits column for clarity
COMMENT ON COLUMN users.credits IS 'Available purchased/referral credits (do not expire)';
COMMENT ON COLUMN users.subscription_credits IS 'Monthly subscription credits (reset each billing cycle)';
COMMENT ON COLUMN users.subscription_credit_reset_date IS 'Next date when subscription credits reset';
