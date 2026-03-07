-- CUTMV Database Reset Script
-- Clean slate for Cloudflare R2 migration
-- Run this to clear all local database entries and start fresh

-- Drop existing tables if they exist
DROP TABLE IF EXISTS clips CASCADE;
DROP TABLE IF EXISTS videos CASCADE;

-- Recreate videos table with R2 support
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    r2_key TEXT,                    -- Cloudflare R2 storage key
    r2_url TEXT,                    -- Cloudflare R2 public URL
    size INTEGER NOT NULL,
    duration TEXT,
    processed BOOLEAN DEFAULT false
);

-- Recreate clips table
CREATE TABLE clips (
    id SERIAL PRIMARY KEY,
    video_id INTEGER REFERENCES videos(id),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT,
    processed BOOLEAN DEFAULT false
);

-- Verify tables were created
SELECT 'Videos table created' as status, COUNT(*) as records FROM videos;
SELECT 'Clips table created' as status, COUNT(*) as records FROM clips;

-- Display schema for verification
\d videos;
\d clips;