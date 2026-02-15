-- VM-Bridge Seed Data
-- Run against the 'cos' database: psql -h localhost -p 5433 -U postgres -d cos -f seed.sql
-- Idempotent: safe to run multiple times

-- ============================================================================
-- Projects (what VMs can do)
-- ============================================================================

INSERT INTO cos_projects (id, name, vm_owner, chrome_profile, repo_path, domain) VALUES
  ('vvg-gbp', 'VVG Google Business Profiles', 'vvg-gbp-ec2', 'vvg', '/home/ubuntu/gbp', 'vvgtruck.com'),
  ('vvg-marketing', 'VVG Marketing Site', 'vvg-marketing-ec2', 'vvg', '/home/ubuntu/marketing', 'vvgtruck.com'),
  ('vvg-it-dashboard', 'VVG IT Dashboard', 'vvg-it-dashboard-ec2', 'vvg', '/home/ubuntu/it-dashboard', 'vvgtruck.com'),
  ('vvg-invoice', 'VVG Invoice Processing', 'vvg-invoice-ec2', 'vvg', '/home/ubuntu/invoice', 'vvgtruck.com'),
  ('vvg-chatbot', 'VVG Chatbot', 'vvg-chatbot-ec2', 'vvg', '/home/ubuntu/chatbot', 'vvgtruck.com')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  vm_owner = EXCLUDED.vm_owner,
  chrome_profile = EXCLUDED.chrome_profile,
  repo_path = EXCLUDED.repo_path,
  domain = EXCLUDED.domain;

-- ============================================================================
-- Intents (what work each project can handle)
-- ============================================================================

-- Clear and re-insert (intents are append-only with serial IDs, so we truncate)
DELETE FROM cos_intents WHERE project_id IN ('vvg-gbp', 'vvg-marketing', 'vvg-it-dashboard', 'vvg-invoice', 'vvg-chatbot');

INSERT INTO cos_intents (project_id, description, keywords) VALUES
  -- VVG GBP
  ('vvg-gbp', 'Update business hours for a location', ARRAY['hours', 'open', 'close', 'schedule', 'sunday', 'monday', 'holiday']),
  ('vvg-gbp', 'Update location description or details', ARRAY['description', 'about', 'info', 'update', 'listing']),
  ('vvg-gbp', 'Add or update photos for a location', ARRAY['photo', 'image', 'picture', 'logo', 'cover']),
  ('vvg-gbp', 'Respond to a Google review', ARRAY['review', 'respond', 'reply', 'feedback', 'stars']),

  -- VVG Marketing
  ('vvg-marketing', 'Update website content', ARRAY['website', 'page', 'content', 'text', 'copy']),
  ('vvg-marketing', 'Create or update landing page', ARRAY['landing', 'page', 'campaign', 'promo']),

  -- VVG IT Dashboard
  ('vvg-it-dashboard', 'Generate or update dashboard report', ARRAY['dashboard', 'report', 'metrics', 'KPI', 'data']),
  ('vvg-it-dashboard', 'Update IT system configuration', ARRAY['config', 'setting', 'system', 'IT']),

  -- VVG Invoice
  ('vvg-invoice', 'Process incoming invoice', ARRAY['invoice', 'bill', 'payment', 'PO', 'vendor']),
  ('vvg-invoice', 'Generate invoice report', ARRAY['report', 'summary', 'outstanding', 'aging']),

  -- VVG Chatbot
  ('vvg-chatbot', 'Update chatbot responses', ARRAY['chatbot', 'response', 'FAQ', 'answer', 'dialog']),
  ('vvg-chatbot', 'Train chatbot on new content', ARRAY['train', 'knowledge', 'content', 'document']);

-- ============================================================================
-- Contacts (who sends emails that trigger work)
-- ============================================================================

INSERT INTO cos_contacts (email, name, roles, project_ids) VALUES
  ('jholt@vvgtruck.com', 'Jennifer Holt', '{"authority": "higher", "expertise": "non-technical"}', ARRAY['vvg-gbp', 'vvg-marketing']),
  ('jwilson@vvgtruck.com', 'Jeff Wilson', '{"authority": "higher", "expertise": "non-technical"}', ARRAY['vvg-gbp', 'vvg-marketing', 'vvg-chatbot']),
  ('jheller@vvgtruck.com', 'Jack Heller', '{"authority": "peer", "expertise": "non-technical"}', ARRAY['vvg-gbp']),
  ('bbhatt@vvgtruck.com', 'Bhavik Bhatt', '{"authority": "peer", "expertise": "technical"}', ARRAY['vvg-it-dashboard', 'vvg-chatbot']),
  ('kmarin@vvgtruck.com', 'Kim Marin', '{"authority": "peer", "expertise": "non-technical"}', ARRAY['vvg-invoice']),
  ('dyuill@vvgtruck.com', 'David Yuill', '{"authority": "higher", "expertise": "non-technical"}', ARRAY['vvg-invoice', 'vvg-it-dashboard']),
  ('michaelabdo@vvgtruck.com', 'Michael Abdo', '{"authority": "self", "expertise": "technical"}', ARRAY['vvg-gbp', 'vvg-marketing', 'vvg-it-dashboard', 'vvg-invoice', 'vvg-chatbot']),
  ('shanti@xcellerateeq.ai', 'Shanti Singh', '{"authority": "peer", "expertise": "technical"}', ARRAY['vvg-it-dashboard', 'vvg-chatbot']),
  ('mike@xcellerateeq.ai', 'Mike Abdo', '{"authority": "self", "expertise": "technical"}', ARRAY['vvg-gbp', 'vvg-marketing', 'vvg-it-dashboard', 'vvg-invoice', 'vvg-chatbot']),
  ('youssef@xcellerateeq.ai', 'Youssef El Beqqal', '{"authority": "peer", "expertise": "technical"}', ARRAY['vvg-marketing', 'vvg-chatbot'])
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  roles = EXCLUDED.roles,
  project_ids = EXCLUDED.project_ids,
  updated_at = NOW();
