-- OpenClaw Hosted Platform - Initial Schema
-- This migration creates the core tables for user management,
-- instance provisioning, and channel connections.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (extends Supabase Auth)
CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'enterprise')),
  subscription_expires_at TIMESTAMPTZ,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User instances (one OpenClaw container per user)
CREATE TABLE public.instances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT DEFAULT 'default',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'provisioning', 'running', 'stopped', 'error')),

  -- DigitalOcean App Platform details
  do_app_id TEXT,
  do_component_name TEXT,

  -- Networking
  public_url TEXT,

  -- Auth (encrypted gateway token)
  gateway_token_encrypted TEXT NOT NULL,

  -- Metadata
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_health_at TIMESTAMPTZ,

  -- One instance per user (for MVP)
  CONSTRAINT one_instance_per_user UNIQUE (user_id, name)
);

-- Channel connections per instance
CREATE TABLE public.channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_id UUID REFERENCES public.instances(id) ON DELETE CASCADE NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('whatsapp', 'telegram', 'discord', 'slack', 'signal')),
  account_id TEXT DEFAULT 'default',

  -- Connection status
  status TEXT DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connecting', 'connected', 'error')),
  linked_identity TEXT, -- e.g., phone number, bot username

  -- Channel-specific config (non-sensitive)
  config JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_connected_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,

  CONSTRAINT unique_channel_per_instance UNIQUE (instance_id, channel_type, account_id)
);

-- Channel credentials (sensitive, encrypted)
CREATE TABLE public.channel_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID REFERENCES public.channels(id) ON DELETE CASCADE NOT NULL UNIQUE,

  -- Encrypted credentials blob
  encrypted_credentials BYTEA NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_instances_user_id ON public.instances(user_id);
CREATE INDEX idx_instances_status ON public.instances(status);
CREATE INDEX idx_channels_instance_id ON public.channels(instance_id);
CREATE INDEX idx_channels_status ON public.channels(status);

-- Updated at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_instances_updated_at
  BEFORE UPDATE ON public.instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_channels_updated_at
  BEFORE UPDATE ON public.channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_channel_credentials_updated_at
  BEFORE UPDATE ON public.channel_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_credentials ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own data

-- Users table policies
CREATE POLICY users_select_own ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY users_update_own ON public.users
  FOR UPDATE USING (auth.uid() = id);

-- Instances table policies
CREATE POLICY instances_select_own ON public.instances
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY instances_insert_own ON public.instances
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY instances_update_own ON public.instances
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY instances_delete_own ON public.instances
  FOR DELETE USING (user_id = auth.uid());

-- Channels table policies
CREATE POLICY channels_select_own ON public.channels
  FOR SELECT USING (
    instance_id IN (SELECT id FROM public.instances WHERE user_id = auth.uid())
  );

CREATE POLICY channels_insert_own ON public.channels
  FOR INSERT WITH CHECK (
    instance_id IN (SELECT id FROM public.instances WHERE user_id = auth.uid())
  );

CREATE POLICY channels_update_own ON public.channels
  FOR UPDATE USING (
    instance_id IN (SELECT id FROM public.instances WHERE user_id = auth.uid())
  );

CREATE POLICY channels_delete_own ON public.channels
  FOR DELETE USING (
    instance_id IN (SELECT id FROM public.instances WHERE user_id = auth.uid())
  );

-- Channel credentials policies
CREATE POLICY channel_credentials_select_own ON public.channel_credentials
  FOR SELECT USING (
    channel_id IN (
      SELECT c.id FROM public.channels c
      JOIN public.instances i ON c.instance_id = i.id
      WHERE i.user_id = auth.uid()
    )
  );

CREATE POLICY channel_credentials_insert_own ON public.channel_credentials
  FOR INSERT WITH CHECK (
    channel_id IN (
      SELECT c.id FROM public.channels c
      JOIN public.instances i ON c.instance_id = i.id
      WHERE i.user_id = auth.uid()
    )
  );

CREATE POLICY channel_credentials_update_own ON public.channel_credentials
  FOR UPDATE USING (
    channel_id IN (
      SELECT c.id FROM public.channels c
      JOIN public.instances i ON c.instance_id = i.id
      WHERE i.user_id = auth.uid()
    )
  );

CREATE POLICY channel_credentials_delete_own ON public.channel_credentials
  FOR DELETE USING (
    channel_id IN (
      SELECT c.id FROM public.channels c
      JOIN public.instances i ON c.instance_id = i.id
      WHERE i.user_id = auth.uid()
    )
  );

-- Function to create user profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, display_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create user profile on signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
