-- 001_vividwalls_seed_adapted.sql
-- Adapted to work with existing column schema (tables owned by postgres).
-- Missing ALTER TABLE columns are worked around by using only existing columns.
-- Safe to re-run: uses ON CONFLICT DO NOTHING.

-- No transaction wrapper: each INSERT is independent so partial failures don't cascade.

-- ============================================================
-- PRODUCTS (30 items) — no category/stock_qty columns; use metadata for category
-- ============================================================
INSERT INTO erp.products (id, sku, name, description, price, currency, status, metadata) VALUES
  ('a0000001-0001-4000-8000-000000000001', 'VW-ABS-001', 'Cosmic Drift', 'Bold abstract swirls in midnight blue and gold', 149.00, 'USD', 'active', '{"category":"Abstract","stock_qty":120}'),
  ('a0000001-0001-4000-8000-000000000002', 'VW-ABS-002', 'Neon Pulse', 'Vibrant neon abstract with electric energy', 129.00, 'USD', 'active', '{"category":"Abstract","stock_qty":85}'),
  ('a0000001-0001-4000-8000-000000000003', 'VW-ABS-003', 'Ember Flow', 'Warm abstract gradients in amber and crimson', 169.00, 'USD', 'active', '{"category":"Abstract","stock_qty":45}'),
  ('a0000001-0001-4000-8000-000000000004', 'VW-ABS-004', 'Ocean Depth', 'Deep sea abstract in teal and navy', 139.00, 'USD', 'active', '{"category":"Abstract","stock_qty":200}'),
  ('a0000001-0001-4000-8000-000000000005', 'VW-ABS-005', 'Solar Flare', 'Explosive abstract in orange and white', 159.00, 'USD', 'active', '{"category":"Abstract","stock_qty":0}'),
  ('a0000001-0001-4000-8000-000000000006', 'VW-MIN-001', 'Silent Line', 'Single stroke minimalist on cream', 79.00, 'USD', 'active', '{"category":"Minimalist","stock_qty":300}'),
  ('a0000001-0001-4000-8000-000000000007', 'VW-MIN-002', 'Void Circle', 'Minimalist circle composition in charcoal', 89.00, 'USD', 'active', '{"category":"Minimalist","stock_qty":250}'),
  ('a0000001-0001-4000-8000-000000000008', 'VW-MIN-003', 'Whisper Grid', 'Subtle grid pattern in soft gray', 69.00, 'USD', 'active', '{"category":"Minimalist","stock_qty":180}'),
  ('a0000001-0001-4000-8000-000000000009', 'VW-MIN-004', 'Balance Point', 'Asymmetric minimalist balance study', 99.00, 'USD', 'active', '{"category":"Minimalist","stock_qty":8}'),
  ('a0000001-0001-4000-8000-000000000010', 'VW-MIN-005', 'Mono Horizon', 'Black and white horizon line', 59.00, 'USD', 'active', '{"category":"Minimalist","stock_qty":400}'),
  ('a0000001-0001-4000-8000-000000000011', 'VW-NAT-001', 'Forest Canopy', 'Lush green forest from above', 179.00, 'USD', 'active', '{"category":"Nature","stock_qty":90}'),
  ('a0000001-0001-4000-8000-000000000012', 'VW-NAT-002', 'Desert Bloom', 'Desert landscape with wildflowers', 159.00, 'USD', 'active', '{"category":"Nature","stock_qty":65}'),
  ('a0000001-0001-4000-8000-000000000013', 'VW-NAT-003', 'Mountain Mist', 'Misty mountain peaks at dawn', 199.00, 'USD', 'active', '{"category":"Nature","stock_qty":40}'),
  ('a0000001-0001-4000-8000-000000000014', 'VW-NAT-004', 'Coral Reef', 'Underwater coral reef panorama', 189.00, 'USD', 'active', '{"category":"Nature","stock_qty":55}'),
  ('a0000001-0001-4000-8000-000000000015', 'VW-NAT-005', 'Aurora Sky', 'Northern lights over frozen lake', 219.00, 'USD', 'active', '{"category":"Nature","stock_qty":3}'),
  ('a0000001-0001-4000-8000-000000000016', 'VW-GEO-001', 'Hex Matrix', 'Hexagonal geometric pattern in copper', 119.00, 'USD', 'active', '{"category":"Geometric","stock_qty":150}'),
  ('a0000001-0001-4000-8000-000000000017', 'VW-GEO-002', 'Prism Break', 'Triangular prism refraction study', 109.00, 'USD', 'active', '{"category":"Geometric","stock_qty":175}'),
  ('a0000001-0001-4000-8000-000000000018', 'VW-GEO-003', 'Tessellation', 'Interlocking geometric tiles in jewel tones', 139.00, 'USD', 'active', '{"category":"Geometric","stock_qty":95}'),
  ('a0000001-0001-4000-8000-000000000019', 'VW-GEO-004', 'Sacred Geometry', 'Flower of life pattern in gold leaf', 249.00, 'USD', 'active', '{"category":"Geometric","stock_qty":25}'),
  ('a0000001-0001-4000-8000-000000000020', 'VW-GEO-005', 'Cube Cascade', '3D cube illusion in monochrome', 99.00, 'USD', 'active', '{"category":"Geometric","stock_qty":210}'),
  ('a0000001-0001-4000-8000-000000000021', 'VW-PRT-001', 'Digital Muse', 'AI-generated portrait in renaissance style', 259.00, 'USD', 'active', '{"category":"Portrait","stock_qty":30}'),
  ('a0000001-0001-4000-8000-000000000022', 'VW-PRT-002', 'Neon Face', 'Cyberpunk portrait with neon accents', 229.00, 'USD', 'active', '{"category":"Portrait","stock_qty":20}'),
  ('a0000001-0001-4000-8000-000000000023', 'VW-PRT-003', 'Watercolor Soul', 'Soft watercolor portrait blend', 189.00, 'USD', 'active', '{"category":"Portrait","stock_qty":50}'),
  ('a0000001-0001-4000-8000-000000000024', 'VW-PRT-004', 'Pop Icon', 'Pop art style portrait in bold colors', 199.00, 'USD', 'active', '{"category":"Portrait","stock_qty":35}'),
  ('a0000001-0001-4000-8000-000000000025', 'VW-PRT-005', 'Sketch Study', 'Detailed pencil sketch portrait', 149.00, 'USD', 'active', '{"category":"Portrait","stock_qty":60}'),
  ('a0000001-0001-4000-8000-000000000026', 'VW-CUS-001', 'Custom Canvas 24x36', 'Custom AI art on 24x36 premium canvas', 299.00, 'USD', 'draft', '{"category":"Custom","stock_qty":0}'),
  ('a0000001-0001-4000-8000-000000000027', 'VW-CUS-002', 'Custom Canvas 18x24', 'Custom AI art on 18x24 premium canvas', 249.00, 'USD', 'draft', '{"category":"Custom","stock_qty":0}'),
  ('a0000001-0001-4000-8000-000000000028', 'VW-CUS-003', 'Custom Print 12x16', 'Custom AI art print on archival paper', 149.00, 'USD', 'draft', '{"category":"Custom","stock_qty":0}'),
  ('a0000001-0001-4000-8000-000000000029', 'VW-CUS-004', 'Custom Metal 20x30', 'Custom AI art on brushed aluminum', 349.00, 'USD', 'draft', '{"category":"Custom","stock_qty":0}'),
  ('a0000001-0001-4000-8000-000000000030', 'VW-CUS-005', 'Custom Poster 16x20', 'Custom AI art poster print', 49.00, 'USD', 'draft', '{"category":"Custom","stock_qty":0}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- WAREHOUSES (2) — insert into both warehouses and supply_nodes
-- ============================================================
INSERT INTO erp.warehouses (id, name, location, capacity, metadata) VALUES
  ('b0000001-0001-4000-8000-000000000001', 'VividWalls Primary', 'Los Angeles, CA', 5000, '{"type":"primary"}'),
  ('b0000001-0001-4000-8000-000000000002', 'VividWalls East', 'Atlanta, GA', 2000, '{"type":"regional"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO erp.supply_nodes (id, name, type, location, metadata) VALUES
  ('b0000001-0001-4000-8000-000000000001', 'VividWalls Primary', 'warehouse', 'Los Angeles, CA', '{"capacity": 5000}'),
  ('b0000001-0001-4000-8000-000000000002', 'VividWalls East', 'warehouse', 'Atlanta, GA', '{"capacity": 2000}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- STOCK ITEMS (30) — no sku/name/status/unit columns; use only existing cols
-- ============================================================
INSERT INTO erp.stock_items (id, product_id, warehouse_id, quantity, reorder_point) VALUES
  ('c0000001-0001-4000-8000-000000000001', 'a0000001-0001-4000-8000-000000000001', 'b0000001-0001-4000-8000-000000000001', 120, 20),
  ('c0000001-0001-4000-8000-000000000002', 'a0000001-0001-4000-8000-000000000002', 'b0000001-0001-4000-8000-000000000001', 85, 15),
  ('c0000001-0001-4000-8000-000000000003', 'a0000001-0001-4000-8000-000000000003', 'b0000001-0001-4000-8000-000000000001', 45, 25),
  ('c0000001-0001-4000-8000-000000000004', 'a0000001-0001-4000-8000-000000000004', 'b0000001-0001-4000-8000-000000000002', 200, 30),
  ('c0000001-0001-4000-8000-000000000005', 'a0000001-0001-4000-8000-000000000005', 'b0000001-0001-4000-8000-000000000001', 0, 20),
  ('c0000001-0001-4000-8000-000000000006', 'a0000001-0001-4000-8000-000000000006', 'b0000001-0001-4000-8000-000000000001', 300, 50),
  ('c0000001-0001-4000-8000-000000000007', 'a0000001-0001-4000-8000-000000000007', 'b0000001-0001-4000-8000-000000000002', 250, 40),
  ('c0000001-0001-4000-8000-000000000008', 'a0000001-0001-4000-8000-000000000008', 'b0000001-0001-4000-8000-000000000001', 180, 30),
  ('c0000001-0001-4000-8000-000000000009', 'a0000001-0001-4000-8000-000000000009', 'b0000001-0001-4000-8000-000000000001', 8, 15),
  ('c0000001-0001-4000-8000-000000000010', 'a0000001-0001-4000-8000-000000000010', 'b0000001-0001-4000-8000-000000000002', 400, 50),
  ('c0000001-0001-4000-8000-000000000011', 'a0000001-0001-4000-8000-000000000011', 'b0000001-0001-4000-8000-000000000001', 90, 20),
  ('c0000001-0001-4000-8000-000000000012', 'a0000001-0001-4000-8000-000000000012', 'b0000001-0001-4000-8000-000000000001', 65, 15),
  ('c0000001-0001-4000-8000-000000000013', 'a0000001-0001-4000-8000-000000000013', 'b0000001-0001-4000-8000-000000000002', 40, 20),
  ('c0000001-0001-4000-8000-000000000014', 'a0000001-0001-4000-8000-000000000014', 'b0000001-0001-4000-8000-000000000001', 55, 15),
  ('c0000001-0001-4000-8000-000000000015', 'a0000001-0001-4000-8000-000000000015', 'b0000001-0001-4000-8000-000000000001', 3, 10),
  ('c0000001-0001-4000-8000-000000000016', 'a0000001-0001-4000-8000-000000000016', 'b0000001-0001-4000-8000-000000000002', 150, 25),
  ('c0000001-0001-4000-8000-000000000017', 'a0000001-0001-4000-8000-000000000017', 'b0000001-0001-4000-8000-000000000001', 175, 30),
  ('c0000001-0001-4000-8000-000000000018', 'a0000001-0001-4000-8000-000000000018', 'b0000001-0001-4000-8000-000000000001', 95, 20),
  ('c0000001-0001-4000-8000-000000000019', 'a0000001-0001-4000-8000-000000000019', 'b0000001-0001-4000-8000-000000000002', 25, 10),
  ('c0000001-0001-4000-8000-000000000020', 'a0000001-0001-4000-8000-000000000020', 'b0000001-0001-4000-8000-000000000001', 210, 35),
  ('c0000001-0001-4000-8000-000000000021', 'a0000001-0001-4000-8000-000000000021', 'b0000001-0001-4000-8000-000000000001', 30, 10),
  ('c0000001-0001-4000-8000-000000000022', 'a0000001-0001-4000-8000-000000000022', 'b0000001-0001-4000-8000-000000000001', 20, 10),
  ('c0000001-0001-4000-8000-000000000023', 'a0000001-0001-4000-8000-000000000023', 'b0000001-0001-4000-8000-000000000002', 50, 15),
  ('c0000001-0001-4000-8000-000000000024', 'a0000001-0001-4000-8000-000000000024', 'b0000001-0001-4000-8000-000000000001', 35, 10),
  ('c0000001-0001-4000-8000-000000000025', 'a0000001-0001-4000-8000-000000000025', 'b0000001-0001-4000-8000-000000000001', 60, 15),
  ('c0000001-0001-4000-8000-000000000026', 'a0000001-0001-4000-8000-000000000026', NULL, 0, 0),
  ('c0000001-0001-4000-8000-000000000027', 'a0000001-0001-4000-8000-000000000027', NULL, 0, 0),
  ('c0000001-0001-4000-8000-000000000028', 'a0000001-0001-4000-8000-000000000028', NULL, 0, 0),
  ('c0000001-0001-4000-8000-000000000029', 'a0000001-0001-4000-8000-000000000029', NULL, 0, 0),
  ('c0000001-0001-4000-8000-000000000030', 'a0000001-0001-4000-8000-000000000030', NULL, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- CONTACTS / CUSTOMERS (50)
-- ============================================================
INSERT INTO erp.contacts (id, name, email, phone, company, segment, lifecycle_stage, metadata) VALUES
  ('d0000001-0001-4000-8000-000000000001', 'Sarah Mitchell', 'sarah.m@gmail.com', '310-555-0101', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000002', 'James Park', 'jpark@outlook.com', '212-555-0102', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000003', 'Emily Chen', 'echen@designstudio.co', '415-555-0103', 'Chen Design Studio', 'designer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000004', 'Michael Torres', 'mtorres@gmail.com', '305-555-0104', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000005', 'Aisha Johnson', 'aisha.j@hotmail.com', '773-555-0105', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000006', 'Robert Kim', 'rkim@interiorspro.com', '206-555-0106', 'Interiors Pro', 'designer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000007', 'Lisa Wang', 'lwang@gmail.com', '408-555-0107', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000008', 'David Patel', 'dpatel@techhub.io', '512-555-0108', 'TechHub Inc', 'b2b', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000009', 'Maria Garcia', 'mgarcia@yahoo.com', '602-555-0109', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000010', 'Kevin O''Brien', 'kobrien@gmail.com', '617-555-0110', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000011', 'Priya Sharma', 'psharma@artcollective.org', '646-555-0111', 'Art Collective', 'b2b', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000012', 'Tom Anderson', 'tanderson@gmail.com', '503-555-0112', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000013', 'Rachel Lee', 'rlee@modernhomes.com', '858-555-0113', 'Modern Homes Realty', 'designer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000014', 'Chris Martinez', 'cmartinez@outlook.com', '720-555-0114', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000015', 'Naomi Williams', 'nwilliams@gmail.com', '404-555-0115', NULL, 'consumer', 'lead', '{}'),
  ('d0000001-0001-4000-8000-000000000016', 'Jennifer Adams', 'jadams@gmail.com', '310-555-0116', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000017', 'Brandon Thompson', 'bthompson@startup.io', '415-555-0117', 'Startup Labs', 'b2b', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000018', 'Olivia Scott', 'oscott@gmail.com', '212-555-0118', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000019', 'Daniel Wright', 'dwright@luxinteriors.com', '305-555-0119', 'Lux Interiors', 'designer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000020', 'Amanda Brown', 'abrown@yahoo.com', '773-555-0120', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000021', 'Ryan Nguyen', 'rnguyen@gmail.com', '206-555-0121', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000022', 'Stephanie Clark', 'sclark@decohaven.com', '408-555-0122', 'DecoHaven', 'designer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000023', 'Marcus Jones', 'mjones@gmail.com', '512-555-0123', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000024', 'Nicole Taylor', 'ntaylor@gmail.com', '602-555-0124', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000025', 'Alex Rivera', 'arivera@coworkspace.com', '617-555-0125', 'CoWork Space', 'b2b', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000026', 'Jessica Hernandez', 'jhernandez@gmail.com', '646-555-0126', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000027', 'Tyler Moore', 'tmoore@outlook.com', '503-555-0127', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000028', 'Samantha Davis', 'sdavis@artdeco.studio', '858-555-0128', 'Art Deco Studio', 'designer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000029', 'Jason White', 'jwhite@gmail.com', '720-555-0129', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000030', 'Lauren Jackson', 'ljackson@hotelgroup.com', '404-555-0130', 'Apex Hotel Group', 'b2b', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000031', 'Anthony Lewis', 'alewis@gmail.com', '310-555-0131', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000032', 'Megan Robinson', 'mrobinson@gmail.com', '415-555-0132', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000033', 'Peter Hall', 'phall@buildcorp.com', '212-555-0133', 'BuildCorp', 'b2b', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000034', 'Diana Young', 'dyoung@gmail.com', '305-555-0134', NULL, 'consumer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000035', 'Steven King', 'sking@stagingpros.com', '773-555-0135', 'Staging Pros', 'designer', 'customer', '{}'),
  ('d0000001-0001-4000-8000-000000000036', 'Catherine Bell', 'cbell@gmail.com', '206-555-0136', NULL, 'consumer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000037', 'Gregory Foster', 'gfoster@elitedecor.com', '408-555-0137', 'Elite Decor', 'designer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000038', 'Hannah Murphy', 'hmurphy@gmail.com', '512-555-0138', NULL, 'consumer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000039', 'Ian Cooper', 'icooper@techoffice.com', '602-555-0139', 'TechOffice', 'b2b', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000040', 'Vanessa Reed', 'vreed@gmail.com', '617-555-0140', NULL, 'consumer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000041', 'William Hayes', 'whayes@luxliving.com', '646-555-0141', 'Lux Living Design', 'designer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000042', 'Sofia Ramirez', 'sramirez@gmail.com', '503-555-0142', NULL, 'consumer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000043', 'Nathan Price', 'nprice@cafechain.com', '858-555-0143', 'Bean & Brew Cafes', 'b2b', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000044', 'Ella Morgan', 'emorgan@gmail.com', '720-555-0144', NULL, 'consumer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000045', 'Patrick Russell', 'prussell@gmail.com', '404-555-0145', NULL, 'consumer', 'loyal', '{}'),
  ('d0000001-0001-4000-8000-000000000046', 'Tina Howard', 'thoward@gmail.com', '310-555-0146', NULL, 'consumer', 'churned', '{}'),
  ('d0000001-0001-4000-8000-000000000047', 'Derek Simmons', 'dsimmons@oldco.com', '415-555-0147', 'OldCo Inc', 'b2b', 'churned', '{}'),
  ('d0000001-0001-4000-8000-000000000048', 'Kimberly Ford', 'kford@gmail.com', '212-555-0148', NULL, 'consumer', 'churned', '{}'),
  ('d0000001-0001-4000-8000-000000000049', 'Wayne Palmer', 'wpalmer@outlook.com', '305-555-0149', NULL, 'consumer', 'churned', '{}'),
  ('d0000001-0001-4000-8000-000000000050', 'Gloria Sanders', 'gsanders@yahoo.com', '773-555-0150', NULL, 'consumer', 'churned', '{}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ACCOUNTS (6)
-- ============================================================
INSERT INTO erp.accounts (id, name, type, currency, balance, parent_id) VALUES
  ('e0000001-0001-4000-8000-000000000001', 'Revenue', 'revenue', 'USD', 18500.00, NULL),
  ('e0000001-0001-4000-8000-000000000002', 'Cost of Goods Sold', 'expense', 'USD', 6200.00, NULL),
  ('e0000001-0001-4000-8000-000000000003', 'Marketing Expense', 'expense', 'USD', 1550.00, NULL),
  ('e0000001-0001-4000-8000-000000000004', 'Operating Expense', 'expense', 'USD', 3800.00, NULL),
  ('e0000001-0001-4000-8000-000000000005', 'Accounts Receivable', 'asset', 'USD', 2750.00, NULL),
  ('e0000001-0001-4000-8000-000000000006', 'Cash', 'asset', 'USD', 12400.00, NULL)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- INVOICES (25)
-- ============================================================
INSERT INTO erp.invoices (id, customer_id, status, amount, currency, due_date, line_items) VALUES
  ('f0000001-0001-4000-8000-000000000001', 'd0000001-0001-4000-8000-000000000016', 'paid', 149.00, 'USD', '2026-02-15', '[{"sku":"VW-ABS-001","qty":1,"price":149}]'),
  ('f0000001-0001-4000-8000-000000000002', 'd0000001-0001-4000-8000-000000000017', 'paid', 358.00, 'USD', '2026-02-10', '[{"sku":"VW-MIN-001","qty":2,"price":79},{"sku":"VW-NAT-001","qty":1,"price":179}]'),
  ('f0000001-0001-4000-8000-000000000003', 'd0000001-0001-4000-8000-000000000018', 'paid', 89.00, 'USD', '2026-02-12', '[{"sku":"VW-MIN-002","qty":1,"price":89}]'),
  ('f0000001-0001-4000-8000-000000000004', 'd0000001-0001-4000-8000-000000000019', 'paid', 498.00, 'USD', '2026-02-08', '[{"sku":"VW-GEO-004","qty":2,"price":249}]'),
  ('f0000001-0001-4000-8000-000000000005', 'd0000001-0001-4000-8000-000000000020', 'paid', 169.00, 'USD', '2026-02-14', '[{"sku":"VW-ABS-003","qty":1,"price":169}]'),
  ('f0000001-0001-4000-8000-000000000006', 'd0000001-0001-4000-8000-000000000036', 'paid', 259.00, 'USD', '2026-02-05', '[{"sku":"VW-PRT-001","qty":1,"price":259}]'),
  ('f0000001-0001-4000-8000-000000000007', 'd0000001-0001-4000-8000-000000000037', 'paid', 556.00, 'USD', '2026-02-03', '[{"sku":"VW-NAT-003","qty":2,"price":199},{"sku":"VW-MIN-003","qty":1,"price":69}]'),
  ('f0000001-0001-4000-8000-000000000008', 'd0000001-0001-4000-8000-000000000038', 'paid', 119.00, 'USD', '2026-02-18', '[{"sku":"VW-GEO-001","qty":1,"price":119}]'),
  ('f0000001-0001-4000-8000-000000000009', 'd0000001-0001-4000-8000-000000000039', 'paid', 447.00, 'USD', '2026-02-07', '[{"sku":"VW-PRT-003","qty":1,"price":189},{"sku":"VW-PRT-001","qty":1,"price":259}]'),
  ('f0000001-0001-4000-8000-000000000010', 'd0000001-0001-4000-8000-000000000021', 'paid', 199.00, 'USD', '2026-02-16', '[{"sku":"VW-NAT-003","qty":1,"price":199}]'),
  ('f0000001-0001-4000-8000-000000000011', 'd0000001-0001-4000-8000-000000000022', 'sent', 278.00, 'USD', '2026-03-05', '[{"sku":"VW-ABS-002","qty":1,"price":129},{"sku":"VW-ABS-001","qty":1,"price":149}]'),
  ('f0000001-0001-4000-8000-000000000012', 'd0000001-0001-4000-8000-000000000023', 'sent', 159.00, 'USD', '2026-03-08', '[{"sku":"VW-NAT-002","qty":1,"price":159}]'),
  ('f0000001-0001-4000-8000-000000000013', 'd0000001-0001-4000-8000-000000000024', 'sent', 229.00, 'USD', '2026-03-10', '[{"sku":"VW-PRT-002","qty":1,"price":229}]'),
  ('f0000001-0001-4000-8000-000000000014', 'd0000001-0001-4000-8000-000000000025', 'sent', 696.00, 'USD', '2026-03-01', '[{"sku":"VW-GEO-003","qty":2,"price":139},{"sku":"VW-ABS-004","qty":3,"price":139}]'),
  ('f0000001-0001-4000-8000-000000000015', 'd0000001-0001-4000-8000-000000000040', 'sent', 189.00, 'USD', '2026-03-12', '[{"sku":"VW-NAT-004","qty":1,"price":189}]'),
  ('f0000001-0001-4000-8000-000000000016', 'd0000001-0001-4000-8000-000000000041', 'sent', 438.00, 'USD', '2026-03-07', '[{"sku":"VW-NAT-005","qty":1,"price":219},{"sku":"VW-NAT-005","qty":1,"price":219}]'),
  ('f0000001-0001-4000-8000-000000000017', 'd0000001-0001-4000-8000-000000000042', 'sent', 99.00, 'USD', '2026-03-15', '[{"sku":"VW-GEO-005","qty":1,"price":99}]'),
  ('f0000001-0001-4000-8000-000000000018', 'd0000001-0001-4000-8000-000000000043', 'sent', 149.00, 'USD', '2026-03-04', '[{"sku":"VW-PRT-005","qty":1,"price":149}]'),
  ('f0000001-0001-4000-8000-000000000019', 'd0000001-0001-4000-8000-000000000026', 'draft', 139.00, 'USD', '2026-03-20', '[{"sku":"VW-ABS-004","qty":1,"price":139}]'),
  ('f0000001-0001-4000-8000-000000000020', 'd0000001-0001-4000-8000-000000000027', 'draft', 258.00, 'USD', '2026-03-22', '[{"sku":"VW-ABS-002","qty":2,"price":129}]'),
  ('f0000001-0001-4000-8000-000000000021', 'd0000001-0001-4000-8000-000000000028', 'draft', 109.00, 'USD', '2026-03-25', '[{"sku":"VW-GEO-002","qty":1,"price":109}]'),
  ('f0000001-0001-4000-8000-000000000022', 'd0000001-0001-4000-8000-000000000029', 'draft', 199.00, 'USD', '2026-03-18', '[{"sku":"VW-PRT-004","qty":1,"price":199}]'),
  ('f0000001-0001-4000-8000-000000000023', 'd0000001-0001-4000-8000-000000000030', 'draft', 537.00, 'USD', '2026-03-28', '[{"sku":"VW-NAT-001","qty":3,"price":179}]'),
  ('f0000001-0001-4000-8000-000000000024', 'd0000001-0001-4000-8000-000000000046', 'overdue', 149.00, 'USD', '2026-01-25', '[{"sku":"VW-ABS-001","qty":1,"price":149}]'),
  ('f0000001-0001-4000-8000-000000000025', 'd0000001-0001-4000-8000-000000000047', 'overdue', 398.00, 'USD', '2026-01-20', '[{"sku":"VW-PRT-004","qty":2,"price":199}]')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ORDERS (40) — no subtotal/tax/shipped_at; store in shipping_address JSONB
-- ============================================================
INSERT INTO erp.orders (id, customer_id, status, total, currency, line_items, shipping_address) VALUES
  ('17000001-0001-4000-8000-000000000001', 'd0000001-0001-4000-8000-000000000016', 'delivered', 163.90, 'USD', '[{"sku":"VW-ABS-001","qty":1,"price":149}]', '{"subtotal":149,"tax":14.90,"shipped_at":"2026-02-04"}'),
  ('17000001-0001-4000-8000-000000000002', 'd0000001-0001-4000-8000-000000000017', 'delivered', 393.80, 'USD', '[{"sku":"VW-MIN-001","qty":2,"price":79},{"sku":"VW-NAT-001","qty":1,"price":179}]', '{"subtotal":358,"tax":35.80,"shipped_at":"2026-02-02"}'),
  ('17000001-0001-4000-8000-000000000003', 'd0000001-0001-4000-8000-000000000018', 'delivered', 97.90, 'USD', '[{"sku":"VW-MIN-002","qty":1,"price":89}]', '{"subtotal":89,"tax":8.90,"shipped_at":"2026-02-06"}'),
  ('17000001-0001-4000-8000-000000000004', 'd0000001-0001-4000-8000-000000000019', 'delivered', 547.80, 'USD', '[{"sku":"VW-GEO-004","qty":2,"price":249}]', '{"subtotal":498,"tax":49.80,"shipped_at":"2026-01-30"}'),
  ('17000001-0001-4000-8000-000000000005', 'd0000001-0001-4000-8000-000000000020', 'delivered', 185.90, 'USD', '[{"sku":"VW-ABS-003","qty":1,"price":169}]', '{"subtotal":169,"tax":16.90,"shipped_at":"2026-02-08"}'),
  ('17000001-0001-4000-8000-000000000006', 'd0000001-0001-4000-8000-000000000036', 'delivered', 284.90, 'USD', '[{"sku":"VW-PRT-001","qty":1,"price":259}]', '{"subtotal":259,"tax":25.90,"shipped_at":"2026-01-28"}'),
  ('17000001-0001-4000-8000-000000000007', 'd0000001-0001-4000-8000-000000000037', 'delivered', 611.60, 'USD', '[{"sku":"VW-NAT-003","qty":2,"price":199},{"sku":"VW-MIN-003","qty":1,"price":69}]', '{"subtotal":556,"tax":55.60,"shipped_at":"2026-01-26"}'),
  ('17000001-0001-4000-8000-000000000008', 'd0000001-0001-4000-8000-000000000038', 'delivered', 130.90, 'USD', '[{"sku":"VW-GEO-001","qty":1,"price":119}]', '{"subtotal":119,"tax":11.90,"shipped_at":"2026-02-11"}'),
  ('17000001-0001-4000-8000-000000000009', 'd0000001-0001-4000-8000-000000000021', 'shipped', 218.90, 'USD', '[{"sku":"VW-NAT-003","qty":1,"price":199}]', '{"subtotal":199,"tax":19.90,"shipped_at":"2026-02-24"}'),
  ('17000001-0001-4000-8000-000000000010', 'd0000001-0001-4000-8000-000000000022', 'shipped', 305.80, 'USD', '[{"sku":"VW-ABS-002","qty":1,"price":129},{"sku":"VW-ABS-001","qty":1,"price":149}]', '{"subtotal":278,"tax":27.80,"shipped_at":"2026-02-23"}'),
  ('17000001-0001-4000-8000-000000000011', 'd0000001-0001-4000-8000-000000000023', 'shipped', 174.90, 'USD', '[{"sku":"VW-NAT-002","qty":1,"price":159}]', '{"subtotal":159,"tax":15.90,"shipped_at":"2026-02-25"}'),
  ('17000001-0001-4000-8000-000000000012', 'd0000001-0001-4000-8000-000000000024', 'shipped', 251.90, 'USD', '[{"sku":"VW-PRT-002","qty":1,"price":229}]', '{"subtotal":229,"tax":22.90,"shipped_at":"2026-02-22"}'),
  ('17000001-0001-4000-8000-000000000013', 'd0000001-0001-4000-8000-000000000025', 'shipped', 765.60, 'USD', '[{"sku":"VW-GEO-003","qty":2,"price":139},{"sku":"VW-ABS-004","qty":3,"price":139}]', '{"subtotal":696,"tax":69.60,"shipped_at":"2026-02-21"}'),
  ('17000001-0001-4000-8000-000000000014', 'd0000001-0001-4000-8000-000000000040', 'shipped', 207.90, 'USD', '[{"sku":"VW-NAT-004","qty":1,"price":189}]', '{"subtotal":189,"tax":18.90,"shipped_at":"2026-02-24"}'),
  ('17000001-0001-4000-8000-000000000015', 'd0000001-0001-4000-8000-000000000041', 'shipped', 481.80, 'USD', '[{"sku":"VW-NAT-005","qty":2,"price":219}]', '{"subtotal":438,"tax":43.80,"shipped_at":"2026-02-23"}'),
  ('17000001-0001-4000-8000-000000000016', 'd0000001-0001-4000-8000-000000000042', 'shipped', 108.90, 'USD', '[{"sku":"VW-GEO-005","qty":1,"price":99}]', '{"subtotal":99,"tax":9.90,"shipped_at":"2026-02-25"}'),
  ('17000001-0001-4000-8000-000000000017', 'd0000001-0001-4000-8000-000000000043', 'shipped', 163.90, 'USD', '[{"sku":"VW-PRT-005","qty":1,"price":149}]', '{"subtotal":149,"tax":14.90,"shipped_at":"2026-02-22"}'),
  ('17000001-0001-4000-8000-000000000018', 'd0000001-0001-4000-8000-000000000044', 'shipped', 240.90, 'USD', '[{"sku":"VW-NAT-005","qty":1,"price":219}]', '{"subtotal":219,"tax":21.90,"shipped_at":"2026-02-26"}'),
  ('17000001-0001-4000-8000-000000000019', 'd0000001-0001-4000-8000-000000000045', 'shipped', 152.90, 'USD', '[{"sku":"VW-ABS-004","qty":1,"price":139}]', '{"subtotal":139,"tax":13.90,"shipped_at":"2026-02-25"}'),
  ('17000001-0001-4000-8000-000000000020', 'd0000001-0001-4000-8000-000000000031', 'shipped', 86.90, 'USD', '[{"sku":"VW-MIN-001","qty":1,"price":79}]', '{"subtotal":79,"tax":7.90,"shipped_at":"2026-02-26"}'),
  ('17000001-0001-4000-8000-000000000021', 'd0000001-0001-4000-8000-000000000032', 'shipped', 174.90, 'USD', '[{"sku":"VW-NAT-002","qty":1,"price":159}]', '{"subtotal":159,"tax":15.90,"shipped_at":"2026-02-27"}'),
  ('17000001-0001-4000-8000-000000000022', 'd0000001-0001-4000-8000-000000000033', 'shipped', 152.90, 'USD', '[{"sku":"VW-ABS-004","qty":1,"price":139}]', '{"subtotal":139,"tax":13.90,"shipped_at":"2026-02-26"}'),
  ('17000001-0001-4000-8000-000000000023', 'd0000001-0001-4000-8000-000000000034', 'shipped', 108.90, 'USD', '[{"sku":"VW-GEO-005","qty":1,"price":99}]', '{"subtotal":99,"tax":9.90,"shipped_at":"2026-02-27"}'),
  ('17000001-0001-4000-8000-000000000024', 'd0000001-0001-4000-8000-000000000026', 'confirmed', 152.90, 'USD', '[{"sku":"VW-ABS-004","qty":1,"price":139}]', '{"subtotal":139,"tax":13.90}'),
  ('17000001-0001-4000-8000-000000000025', 'd0000001-0001-4000-8000-000000000027', 'confirmed', 283.80, 'USD', '[{"sku":"VW-ABS-002","qty":2,"price":129}]', '{"subtotal":258,"tax":25.80}'),
  ('17000001-0001-4000-8000-000000000026', 'd0000001-0001-4000-8000-000000000028', 'confirmed', 119.90, 'USD', '[{"sku":"VW-GEO-002","qty":1,"price":109}]', '{"subtotal":109,"tax":10.90}'),
  ('17000001-0001-4000-8000-000000000027', 'd0000001-0001-4000-8000-000000000029', 'confirmed', 218.90, 'USD', '[{"sku":"VW-PRT-004","qty":1,"price":199}]', '{"subtotal":199,"tax":19.90}'),
  ('17000001-0001-4000-8000-000000000028', 'd0000001-0001-4000-8000-000000000030', 'confirmed', 590.70, 'USD', '[{"sku":"VW-NAT-001","qty":3,"price":179}]', '{"subtotal":537,"tax":53.70}'),
  ('17000001-0001-4000-8000-000000000029', 'd0000001-0001-4000-8000-000000000035', 'confirmed', 163.90, 'USD', '[{"sku":"VW-ABS-001","qty":1,"price":149}]', '{"subtotal":149,"tax":14.90}'),
  ('17000001-0001-4000-8000-000000000030', 'd0000001-0001-4000-8000-000000000039', 'confirmed', 273.90, 'USD', '[{"sku":"VW-GEO-004","qty":1,"price":249}]', '{"subtotal":249,"tax":24.90}'),
  ('17000001-0001-4000-8000-000000000031', 'd0000001-0001-4000-8000-000000000036', 'confirmed', 86.90, 'USD', '[{"sku":"VW-MIN-001","qty":1,"price":79}]', '{"subtotal":79,"tax":7.90}'),
  ('17000001-0001-4000-8000-000000000032', 'd0000001-0001-4000-8000-000000000037', 'confirmed', 152.90, 'USD', '[{"sku":"VW-ABS-004","qty":1,"price":139}]', '{"subtotal":139,"tax":13.90}'),
  ('17000001-0001-4000-8000-000000000033', 'd0000001-0001-4000-8000-000000000038', 'confirmed', 75.90, 'USD', '[{"sku":"VW-MIN-003","qty":1,"price":69}]', '{"subtotal":69,"tax":6.90}'),
  ('17000001-0001-4000-8000-000000000034', 'd0000001-0001-4000-8000-000000000001', 'pending', 163.90, 'USD', '[{"sku":"VW-ABS-001","qty":1,"price":149}]', '{"subtotal":149,"tax":14.90}'),
  ('17000001-0001-4000-8000-000000000035', 'd0000001-0001-4000-8000-000000000002', 'pending', 97.90, 'USD', '[{"sku":"VW-MIN-002","qty":1,"price":89}]', '{"subtotal":89,"tax":8.90}'),
  ('17000001-0001-4000-8000-000000000036', 'd0000001-0001-4000-8000-000000000003', 'pending', 350.90, 'USD', '[{"sku":"VW-GEO-003","qty":1,"price":139},{"sku":"VW-NAT-001","qty":1,"price":179}]', '{"subtotal":318,"tax":32.90}'),
  ('17000001-0001-4000-8000-000000000037', 'd0000001-0001-4000-8000-000000000004', 'pending', 218.90, 'USD', '[{"sku":"VW-PRT-003","qty":1,"price":189}]', '{"subtotal":189,"tax":29.90}'),
  ('17000001-0001-4000-8000-000000000038', 'd0000001-0001-4000-8000-000000000005', 'pending', 86.90, 'USD', '[{"sku":"VW-MIN-001","qty":1,"price":79}]', '{"subtotal":79,"tax":7.90}'),
  ('17000001-0001-4000-8000-000000000039', 'd0000001-0001-4000-8000-000000000046', 'cancelled', 163.90, 'USD', '[{"sku":"VW-ABS-001","qty":1,"price":149}]', '{"subtotal":149,"tax":14.90}'),
  ('17000001-0001-4000-8000-000000000040', 'd0000001-0001-4000-8000-000000000047', 'cancelled', 437.80, 'USD', '[{"sku":"VW-PRT-004","qty":2,"price":199}]', '{"subtotal":398,"tax":39.80}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- SUPPLIERS (4) — no terms column; use payment_terms instead
-- ============================================================
INSERT INTO erp.suppliers (id, name, contact_email, category, rating, status, payment_terms, metadata) VALUES
  ('18000001-0001-4000-8000-000000000001', 'PrintHouse Pro', 'orders@printhousepro.com', 'printing', 4.5, 'active', 'Net 30', '{"specialties":["canvas","archival paper","metal prints"]}'),
  ('18000001-0001-4000-8000-000000000002', 'FrameCraft Studios', 'sales@framecraft.com', 'framing', 4.2, 'active', 'Net 45', '{"specialties":["custom framing","shadow boxes","floating frames"]}'),
  ('18000001-0001-4000-8000-000000000003', 'PackRight Fulfillment', 'ops@packright.co', 'packaging', 4.8, 'active', 'Net 15', '{"specialties":["art packaging","bubble wrap","custom boxes"]}'),
  ('18000001-0001-4000-8000-000000000004', 'ArtShip Express', 'dispatch@artshipx.com', 'logistics', 3.9, 'active', 'Prepaid', '{"specialties":["fragile shipping","white glove","international"]}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- PURCHASE ORDERS (8)
-- ============================================================
INSERT INTO erp.purchase_orders (id, supplier_id, items, total_cost, status, expected_delivery) VALUES
  ('19000001-0001-4000-8000-000000000001', '18000001-0001-4000-8000-000000000001', '[{"item":"Canvas rolls 24x36","qty":50,"unit_price":12},{"item":"Archival paper packs","qty":100,"unit_price":5}]', 1100.00, 'draft', '2026-03-15'),
  ('19000001-0001-4000-8000-000000000002', '18000001-0001-4000-8000-000000000002', '[{"item":"Floating frames 24x36","qty":30,"unit_price":28}]', 840.00, 'draft', '2026-03-20'),
  ('19000001-0001-4000-8000-000000000003', '18000001-0001-4000-8000-000000000001', '[{"item":"Metal print blanks 20x30","qty":25,"unit_price":35}]', 875.00, 'submitted', '2026-03-10'),
  ('19000001-0001-4000-8000-000000000004', '18000001-0001-4000-8000-000000000003', '[{"item":"Custom boxes (medium)","qty":200,"unit_price":3.50},{"item":"Bubble wrap rolls","qty":20,"unit_price":15}]', 1000.00, 'submitted', '2026-03-05'),
  ('19000001-0001-4000-8000-000000000005', '18000001-0001-4000-8000-000000000001', '[{"item":"Canvas rolls 18x24","qty":75,"unit_price":8}]', 600.00, 'approved', '2026-03-01'),
  ('19000001-0001-4000-8000-000000000006', '18000001-0001-4000-8000-000000000003', '[{"item":"Tissue paper (acid-free)","qty":500,"unit_price":0.50},{"item":"Corner protectors","qty":300,"unit_price":1}]', 550.00, 'approved', '2026-02-28'),
  ('19000001-0001-4000-8000-000000000007', '18000001-0001-4000-8000-000000000002', '[{"item":"Shadow box frames 12x16","qty":40,"unit_price":18}]', 720.00, 'shipped', '2026-02-27'),
  ('19000001-0001-4000-8000-000000000008', '18000001-0001-4000-8000-000000000001', '[{"item":"Archival ink cartridges","qty":10,"unit_price":45}]', 450.00, 'received', '2026-02-20')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- CAMPAIGNS (6) — no target_audience/channels columns; use target_segment/channel
-- ============================================================
INSERT INTO erp.campaigns (id, name, type, status, budget, start_date, end_date, target_segment, channel, goals, metrics) VALUES
  ('1a000001-0001-4000-8000-000000000001', 'Spring Collection Launch', 'awareness', 'active', 500.00, '2026-02-15', '2026-03-31', 'Home decor enthusiasts 25-45', 'Meta Ads', '{"primary":"Brand awareness","secondary":"Traffic"}', '{"impressions":45000,"clicks":1800}'),
  ('1a000001-0001-4000-8000-000000000002', 'Pinterest Home Decor', 'traffic', 'active', 400.00, '2026-02-01', '2026-04-30', 'Pinterest users interested in wall art', 'Pinterest', '{"primary":"Website traffic","secondary":"Saves"}', '{"impressions":62000,"clicks":3100}'),
  ('1a000001-0001-4000-8000-000000000003', 'Email Welcome Series', 'nurture', 'active', 0.00, '2026-01-15', NULL, 'New subscribers', 'Email', '{"primary":"Onboarding","secondary":"First purchase"}', '{"opens":890,"clicks":245}'),
  ('1a000001-0001-4000-8000-000000000004', 'Instagram Growth', 'awareness', 'active', 300.00, '2026-02-01', '2026-05-31', 'Art lovers and interior designers', 'Instagram', '{"primary":"Follower growth","secondary":"Engagement"}', '{"impressions":28000,"followers_gained":420}'),
  ('1a000001-0001-4000-8000-000000000005', 'Valentine''s Day Sale', 'conversion', 'completed', 200.00, '2026-02-07', '2026-02-15', 'Gift shoppers', 'Multi-channel', '{"primary":"Sales","secondary":"AOV increase"}', '{"impressions":35000,"clicks":2100,"conversions":65,"revenue":8200}'),
  ('1a000001-0001-4000-8000-000000000006', 'Abstract Art Week', 'awareness', 'paused', 150.00, '2026-02-10', '2026-02-17', 'Abstract art collectors', 'Meta Ads', '{"primary":"Collection awareness"}', '{"impressions":8500,"clicks":340}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- KPIs (6) — no status column; use query field for extra info
-- ============================================================
INSERT INTO erp.kpis (id, name, target, current, unit, period, domain, query) VALUES
  ('1b000001-0001-4000-8000-000000000001', 'Conversion Rate', 3.5, 2.8, '%', 'monthly', 'marketing', 'SELECT (COUNT(*) FILTER (WHERE status=''delivered'')::decimal / COUNT(*)) * 100 FROM erp.orders'),
  ('1b000001-0001-4000-8000-000000000002', 'Average Order Value', 120, 95, 'USD', 'monthly', 'marketing', 'SELECT AVG(total) FROM erp.orders WHERE status NOT IN (''cancelled'')'),
  ('1b000001-0001-4000-8000-000000000003', 'Email Subscribers', 3000, 1250, 'subscribers', 'quarterly', 'marketing', 'SELECT COUNT(*) FROM erp.contacts WHERE lifecycle_stage != ''churned'''),
  ('1b000001-0001-4000-8000-000000000004', 'ROAS', 15, 8.5, 'x', 'monthly', 'marketing', 'SELECT SUM(total) / NULLIF(SUM(budget),0) FROM erp.orders, erp.campaigns'),
  ('1b000001-0001-4000-8000-000000000005', 'Monthly Revenue', 30000, 18500, 'USD', 'monthly', 'finance', 'SELECT SUM(total) FROM erp.orders WHERE status NOT IN (''cancelled'')'),
  ('1b000001-0001-4000-8000-000000000006', 'Instagram Followers', 10000, 3200, 'followers', 'quarterly', 'marketing', 'SELECT value FROM erp.campaign_metrics WHERE metric_type=''followers_gained'' ORDER BY recorded_at DESC LIMIT 1')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- CAMPAIGN METRICS (20)
-- ============================================================
INSERT INTO erp.campaign_metrics (id, campaign_id, metric_type, value, recorded_at) VALUES
  ('1c000001-0001-4000-8000-000000000001', '1a000001-0001-4000-8000-000000000001', 'impressions', 45000, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000002', '1a000001-0001-4000-8000-000000000001', 'clicks', 1800, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000003', '1a000001-0001-4000-8000-000000000001', 'conversions', 42, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000004', '1a000001-0001-4000-8000-000000000001', 'revenue', 5200, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000005', '1a000001-0001-4000-8000-000000000002', 'impressions', 62000, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000006', '1a000001-0001-4000-8000-000000000002', 'clicks', 3100, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000007', '1a000001-0001-4000-8000-000000000002', 'conversions', 28, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000008', '1a000001-0001-4000-8000-000000000002', 'revenue', 3400, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000009', '1a000001-0001-4000-8000-000000000003', 'opens', 890, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000010', '1a000001-0001-4000-8000-000000000003', 'clicks', 245, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000011', '1a000001-0001-4000-8000-000000000003', 'conversions', 18, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000012', '1a000001-0001-4000-8000-000000000004', 'impressions', 28000, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000013', '1a000001-0001-4000-8000-000000000004', 'followers_gained', 420, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000014', '1a000001-0001-4000-8000-000000000004', 'engagement_rate', 4.2, '2026-02-20'),
  ('1c000001-0001-4000-8000-000000000015', '1a000001-0001-4000-8000-000000000005', 'impressions', 35000, '2026-02-16'),
  ('1c000001-0001-4000-8000-000000000016', '1a000001-0001-4000-8000-000000000005', 'clicks', 2100, '2026-02-16'),
  ('1c000001-0001-4000-8000-000000000017', '1a000001-0001-4000-8000-000000000005', 'conversions', 65, '2026-02-16'),
  ('1c000001-0001-4000-8000-000000000018', '1a000001-0001-4000-8000-000000000005', 'revenue', 8200, '2026-02-16'),
  ('1c000001-0001-4000-8000-000000000019', '1a000001-0001-4000-8000-000000000006', 'impressions', 8500, '2026-02-14'),
  ('1c000001-0001-4000-8000-000000000020', '1a000001-0001-4000-8000-000000000006', 'clicks', 340, '2026-02-14')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- SHIPMENTS (15) — use existing columns: origin_node_id, dest_node_id, tracking JSONB
-- ============================================================
INSERT INTO erp.shipments (id, order_id, carrier, status, origin_node_id, tracking) VALUES
  ('1d000001-0001-4000-8000-000000000001', '17000001-0001-4000-8000-000000000001', 'USPS', 'delivered', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"USPS9400111899223100001","origin":"Los Angeles, CA","destination":"San Diego, CA","estimated_arrival":"2026-02-06","actual_arrival":"2026-02-05"}'),
  ('1d000001-0001-4000-8000-000000000002', '17000001-0001-4000-8000-000000000002', 'UPS', 'delivered', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"UPS1Z999AA10123456784","origin":"Los Angeles, CA","destination":"San Francisco, CA","estimated_arrival":"2026-02-05","actual_arrival":"2026-02-04"}'),
  ('1d000001-0001-4000-8000-000000000003', '17000001-0001-4000-8000-000000000003', 'FedEx', 'delivered', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"FX794644790025","origin":"Los Angeles, CA","destination":"New York, NY","estimated_arrival":"2026-02-10","actual_arrival":"2026-02-09"}'),
  ('1d000001-0001-4000-8000-000000000004', '17000001-0001-4000-8000-000000000004', 'UPS', 'delivered', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"UPS1Z999AA10123456785","origin":"Los Angeles, CA","destination":"Miami, FL","estimated_arrival":"2026-02-03","actual_arrival":"2026-02-02"}'),
  ('1d000001-0001-4000-8000-000000000005', '17000001-0001-4000-8000-000000000005', 'USPS', 'delivered', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"USPS9400111899223100002","origin":"Los Angeles, CA","destination":"Chicago, IL","estimated_arrival":"2026-02-12","actual_arrival":"2026-02-11"}'),
  ('1d000001-0001-4000-8000-000000000006', '17000001-0001-4000-8000-000000000009', 'UPS', 'in_transit', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"UPS1Z999AA10123456786","origin":"Los Angeles, CA","destination":"Portland, OR","estimated_arrival":"2026-03-01"}'),
  ('1d000001-0001-4000-8000-000000000007', '17000001-0001-4000-8000-000000000010', 'FedEx', 'in_transit', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"FX794644790026","origin":"Los Angeles, CA","destination":"Seattle, WA","estimated_arrival":"2026-03-02"}'),
  ('1d000001-0001-4000-8000-000000000008', '17000001-0001-4000-8000-000000000011', 'USPS', 'in_transit', 'b0000001-0001-4000-8000-000000000002', '{"tracking_number":"USPS9400111899223100003","origin":"Atlanta, GA","destination":"Boston, MA","estimated_arrival":"2026-03-03"}'),
  ('1d000001-0001-4000-8000-000000000009', '17000001-0001-4000-8000-000000000012', 'UPS', 'in_transit', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"UPS1Z999AA10123456787","origin":"Los Angeles, CA","destination":"Denver, CO","estimated_arrival":"2026-03-01"}'),
  ('1d000001-0001-4000-8000-000000000010', '17000001-0001-4000-8000-000000000013', 'FedEx', 'pending', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"FX794644790027","origin":"Los Angeles, CA","destination":"Austin, TX","estimated_arrival":"2026-03-05"}'),
  ('1d000001-0001-4000-8000-000000000011', '17000001-0001-4000-8000-000000000014', 'USPS', 'pending', 'b0000001-0001-4000-8000-000000000002', '{"tracking_number":"USPS9400111899223100004","origin":"Atlanta, GA","destination":"Nashville, TN","estimated_arrival":"2026-03-04"}'),
  ('1d000001-0001-4000-8000-000000000012', '17000001-0001-4000-8000-000000000015', 'UPS', 'pending', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"UPS1Z999AA10123456788","origin":"Los Angeles, CA","destination":"Phoenix, AZ","estimated_arrival":"2026-03-03"}'),
  ('1d000001-0001-4000-8000-000000000013', '17000001-0001-4000-8000-000000000016', 'FedEx', 'delayed', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"FX794644790028","origin":"Los Angeles, CA","destination":"Minneapolis, MN","estimated_arrival":"2026-02-25"}'),
  ('1d000001-0001-4000-8000-000000000014', '17000001-0001-4000-8000-000000000017', 'USPS', 'delayed', 'b0000001-0001-4000-8000-000000000002', '{"tracking_number":"USPS9400111899223100005","origin":"Atlanta, GA","destination":"Detroit, MI","estimated_arrival":"2026-02-24"}'),
  ('1d000001-0001-4000-8000-000000000015', '17000001-0001-4000-8000-000000000039', 'UPS', 'returned', 'b0000001-0001-4000-8000-000000000001', '{"tracking_number":"UPS1Z999AA10123456789","origin":"Los Angeles, CA","destination":"Houston, TX","estimated_arrival":"2026-02-20"}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ROUTES (4)
-- ============================================================
INSERT INTO erp.routes (id, name, origin, destination, legs, status) VALUES
  ('1e000001-0001-4000-8000-000000000001', 'West Coast Direct', 'Los Angeles, CA', 'Customer (West)', '[{"from":"Los Angeles, CA","to":"Customer","carrier":"USPS","duration":"2-4 days"}]', 'active'),
  ('1e000001-0001-4000-8000-000000000002', 'East Coast via Hub', 'Los Angeles, CA', 'Customer (East)', '[{"from":"Los Angeles, CA","to":"Atlanta, GA","carrier":"FedEx","duration":"3 days"},{"from":"Atlanta, GA","to":"Customer","carrier":"USPS","duration":"1-2 days"}]', 'active'),
  ('1e000001-0001-4000-8000-000000000003', 'East Coast Direct', 'Atlanta, GA', 'Customer (East)', '[{"from":"Atlanta, GA","to":"Customer","carrier":"UPS","duration":"1-3 days"}]', 'active'),
  ('1e000001-0001-4000-8000-000000000004', 'Supplier Inbound', 'International', 'Los Angeles, CA', '[{"from":"Shenzhen, CN","to":"Long Beach Port","carrier":"Ocean","duration":"21 days"},{"from":"Long Beach Port","to":"Los Angeles, CA","carrier":"Truck","duration":"1 day"}]', 'active')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- COMPLIANCE POLICIES (8) + VIOLATIONS (5)
-- ============================================================
INSERT INTO erp.policies (id, title, category, version, status, effective_date, content) VALUES
  ('1f000001-0001-4000-8000-000000000001', 'GDPR Data Handling Policy', 'privacy', '1.2', 'active', '2026-01-01', 'All customer PII must be encrypted at rest and in transit. Data retention limited to 36 months. Right to erasure must be fulfilled within 30 days.'),
  ('1f000001-0001-4000-8000-000000000002', 'CCPA Consumer Rights Policy', 'privacy', '1.0', 'active', '2026-01-01', 'California consumers have the right to know, delete, and opt-out of sale of personal information. Annual disclosure required.'),
  ('1f000001-0001-4000-8000-000000000003', 'Return & Refund Policy', 'operational', '2.1', 'active', '2026-01-15', '30-day return window for undamaged items. Full refund within 5 business days. Custom orders non-refundable.'),
  ('1f000001-0001-4000-8000-000000000004', 'Intellectual Property Policy', 'legal', '1.0', 'active', '2026-01-01', 'All AI-generated art is owned by VividWalls. Customer receives non-exclusive personal use license. Commercial licenses available for B2B.'),
  ('1f000001-0001-4000-8000-000000000005', 'Marketing Ethics Policy', 'marketing', '1.1', 'active', '2026-01-15', 'No misleading claims. All testimonials must be verified. AI art labeled as AI-generated. CAN-SPAM compliance for all emails.'),
  ('1f000001-0001-4000-8000-000000000006', 'PCI DSS Compliance Policy', 'security', '1.0', 'active', '2026-01-01', 'No storage of full card numbers. Tokenized payment processing via Stripe. Quarterly vulnerability scans required.'),
  ('1f000001-0001-4000-8000-000000000007', 'Age Verification Policy', 'legal', '1.0', 'active', '2026-01-01', 'No sales to minors under 13. Age gate on custom portrait orders. Parental consent required for under-18 custom work.'),
  ('1f000001-0001-4000-8000-000000000008', 'Accessibility Compliance (ADA/WCAG)', 'accessibility', '1.0', 'draft', '2026-03-01', 'Website must meet WCAG 2.1 AA standards. Alt text for all product images. Keyboard navigation support required.')
ON CONFLICT (id) DO NOTHING;

-- Violations — use existing columns: rule_id, entity_type, entity_id, severity, resolution
INSERT INTO erp.violations (id, rule_id, entity_type, entity_id, severity, resolution, resolved_at) VALUES
  ('20000001-0001-4000-8000-000000000001', '1f000001-0001-4000-8000-000000000001', 'policy', '1f000001-0001-4000-8000-000000000001', 'critical', NULL, NULL),
  ('20000001-0001-4000-8000-000000000002', '1f000001-0001-4000-8000-000000000005', 'policy', '1f000001-0001-4000-8000-000000000005', 'medium', NULL, NULL),
  ('20000001-0001-4000-8000-000000000003', '1f000001-0001-4000-8000-000000000003', 'policy', '1f000001-0001-4000-8000-000000000003', 'low', 'Exception approved by COO. Process updated to require documentation for all overrides.', '2026-02-15'),
  ('20000001-0001-4000-8000-000000000004', '1f000001-0001-4000-8000-000000000006', 'policy', '1f000001-0001-4000-8000-000000000006', 'medium', 'Scan completed. No vulnerabilities found. Calendar reminder set for future scans.', '2026-02-10'),
  ('20000001-0001-4000-8000-000000000005', '1f000001-0001-4000-8000-000000000004', 'policy', '1f000001-0001-4000-8000-000000000004', 'low', 'Image updated with AI disclosure tag. All ad creatives reviewed and updated.', '2026-02-18')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- LEGAL: Structure, Contracts, Docs, Guardrails
-- ============================================================
INSERT INTO erp.legal_structure (id, business_name, legal_name, entity_type, state_of_formation, ein, formation_date, registered_agent, principal_address) VALUES
  ('21000001-0001-4000-8000-000000000001', 'VividWalls', 'VividWalls LLC', 'llc', 'Delaware', '88-1234567', '2025-12-15', 'Registered Agents Inc.', '1234 Sunset Blvd, Los Angeles, CA 90028')
ON CONFLICT (id) DO NOTHING;

INSERT INTO erp.partnership_contracts (id, partner_name, partner_type, ownership_pct, revenue_share_pct, status, start_date, end_date, terms) VALUES
  ('22000001-0001-4000-8000-000000000001', 'The Artisan Gallery', 'company', NULL, 15.00, 'active', '2026-01-15', '2027-01-15', '{"title":"Artisan Gallery Partnership","display_locations":3,"exclusivity":"non-exclusive","commission":"15% of gallery sales"}'),
  ('22000001-0001-4000-8000-000000000002', 'Maya Torres', 'individual', NULL, 10.00, 'active', '2026-02-01', '2026-08-01', '{"title":"Artist Collaboration — Maya Torres","collection_name":"Urban Dreams","pieces":12,"royalty":"10% per sale"}'),
  ('22000001-0001-4000-8000-000000000003', 'Design Collective Network', 'company', NULL, 20.00, 'draft', NULL, NULL, '{"title":"Interior Designer Referral Program","commission":"20% referral fee","minimum_order":500,"tier":"gold"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO erp.freelancer_contracts (id, contractor_name, scope_of_work, rate_type, rate_amount, currency, status, start_date, end_date, deliverables) VALUES
  ('23000001-0001-4000-8000-000000000001', 'Alex Chen', 'Product mockups, social media graphics, email templates', 'hourly', 75.00, 'USD', 'active', '2026-01-10', '2026-07-10', '["Product mockups (3/week)","Social media templates","Email header designs"]'),
  ('23000001-0001-4000-8000-000000000002', 'Jordan Lee', 'Instagram and TikTok content creation, community management, analytics reporting', 'retainer', 2500.00, 'USD', 'active', '2026-01-15', '2026-04-15', '["5 posts/week","Daily community engagement","Monthly analytics report"]'),
  ('23000001-0001-4000-8000-000000000003', 'Sam Rivera', 'Product descriptions, blog posts, email copy', 'hourly', 50.00, 'USD', 'active', '2026-02-01', '2026-05-01', '["30 product descriptions","4 blog posts/month","Email campaign copy"]'),
  ('23000001-0001-4000-8000-000000000004', 'Nina Patel', 'Lifestyle photography for spring collection launch', 'fixed', 500.00, 'USD', 'completed', '2026-02-10', '2026-02-14', '["20 lifestyle photos","5 flat-lay compositions","Post-processing included"]')
ON CONFLICT (id) DO NOTHING;

INSERT INTO erp.corporate_documents (id, title, doc_type, status, filing_date, expiry_date, jurisdiction, document_url, metadata) VALUES
  ('24000001-0001-4000-8000-000000000001', 'Articles of Incorporation — VividWalls LLC', 'articles_of_incorporation', 'active', '2025-12-15', NULL, 'Delaware', '/docs/legal/articles-of-incorporation.pdf', '{"filed_with":"Delaware Division of Corporations"}'),
  ('24000001-0001-4000-8000-000000000002', 'Operating Agreement', 'operating_agreement', 'active', '2025-12-15', NULL, 'Delaware', '/docs/legal/operating-agreement.pdf', '{"version":"1.0","signatories":["Kingsley Bercy"]}'),
  ('24000001-0001-4000-8000-000000000003', 'EIN Confirmation Letter (IRS)', 'ein_letter', 'active', '2025-12-20', NULL, 'Federal', '/docs/legal/ein-letter.pdf', '{"ein":"88-1234567"}'),
  ('24000001-0001-4000-8000-000000000004', 'City of Los Angeles Business License', 'business_license', 'active', '2026-01-05', '2027-01-05', 'California — Los Angeles', '/docs/legal/business-license.pdf', '{"license_number":"BL-2026-004521"}'),
  ('24000001-0001-4000-8000-000000000005', 'VividWalls Trademark Registration', 'trademark', 'active', '2026-01-20', '2036-01-20', 'Federal (USPTO)', '/docs/legal/trademark-registration.pdf', '{"registration_number":"7,234,567","class":"IC 016 — Prints and publications"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO erp.compliance_guardrails (id, name, category, description, rule_expression, severity, active) VALUES
  ('25000001-0001-4000-8000-000000000001', 'Marketing Spend Cap', 'financial', 'Monthly marketing spend must not exceed $2,000 without CFO approval', 'marketing_monthly_spend <= 2000', 'warning', true),
  ('25000001-0001-4000-8000-000000000002', 'Order Fulfillment SLA', 'operational', 'Orders must ship within 3 business days of payment', 'order_ship_time_days <= 3', 'critical', true),
  ('25000001-0001-4000-8000-000000000003', 'GDPR Data Retention', 'legal', 'Customer PII must be purged after 36 months of inactivity', 'customer_inactive_months <= 36', 'critical', true),
  ('25000001-0001-4000-8000-000000000004', 'Sales Tax Collection', 'tax', 'Sales tax must be collected for all US orders based on destination state', 'us_order_has_tax == true', 'critical', true),
  ('25000001-0001-4000-8000-000000000005', 'Inventory Reorder Threshold', 'operational', 'Auto-reorder triggered when stock falls below reorder point', 'stock_qty >= reorder_point', 'warning', true),
  ('25000001-0001-4000-8000-000000000006', 'Minimum Product Price Floor', 'financial', 'No product may be sold below $39 to maintain brand positioning', 'product_price >= 39', 'warning', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ANALYTICS: Reports (4) + Dashboards (2) + Snapshots (3)
-- ============================================================
INSERT INTO erp.reports (id, name, type, query, parameters, schedule, status, last_run_at) VALUES
  ('26000001-0001-4000-8000-000000000001', 'Monthly Revenue Report', 'financial', 'SELECT date_trunc(''month'', created_at) as month, SUM(total) as revenue FROM erp.orders WHERE status NOT IN (''cancelled'') GROUP BY 1 ORDER BY 1', '{}', '0 0 1 * *', 'active', '2026-02-01'),
  ('26000001-0001-4000-8000-000000000002', 'Customer Acquisition Report', 'operational', 'SELECT lifecycle_stage, COUNT(*) as count FROM erp.contacts GROUP BY 1', '{}', '0 9 * * 1', 'active', '2026-02-24'),
  ('26000001-0001-4000-8000-000000000003', 'Product Performance Report', 'kpi', 'SELECT p.name, p.metadata->>''category'' as category, COUNT(o.id) as order_count FROM erp.products p LEFT JOIN erp.orders o ON o.line_items::text LIKE ''%'' || p.sku || ''%'' GROUP BY 1,2 ORDER BY 3 DESC', '{}', '0 9 * * *', 'active', '2026-02-27'),
  ('26000001-0001-4000-8000-000000000004', 'Campaign ROI Report', 'financial', 'SELECT c.name, c.budget, SUM(cm.value) FILTER (WHERE cm.metric_type=''revenue'') as revenue FROM erp.campaigns c LEFT JOIN erp.campaign_metrics cm ON cm.campaign_id=c.id GROUP BY 1,2', '{}', '0 0 * * 1', 'active', '2026-02-24')
ON CONFLICT (id) DO NOTHING;

-- Dashboards — use existing columns: name, owner_agent_id, layout, kpi_ids
INSERT INTO erp.dashboards (id, name, owner_agent_id, layout, kpi_ids) VALUES
  ('27000001-0001-4000-8000-000000000001', 'CEO Overview', 'ceo_agent', '{"columns":12,"rowHeight":80,"description":"Executive dashboard with key business metrics","widgets":[{"type":"kpi","reportId":"v0000001-0001-4000-8000-000000000001"},{"type":"chart","reportId":"v0000001-0001-4000-8000-000000000002"},{"type":"table","reportId":"v0000001-0001-4000-8000-000000000003"},{"type":"chart","reportId":"v0000001-0001-4000-8000-000000000004"}]}', ARRAY['1b000001-0001-4000-8000-000000000005'::uuid, '1b000001-0001-4000-8000-000000000001'::uuid, '1b000001-0001-4000-8000-000000000002'::uuid]),
  ('27000001-0001-4000-8000-000000000002', 'Marketing Performance', 'cmo_agent', '{"columns":12,"rowHeight":80,"description":"Campaign metrics and marketing KPIs","widgets":[{"type":"kpi","reportId":"v0000001-0001-4000-8000-000000000004"},{"type":"chart","reportId":"v0000001-0001-4000-8000-000000000001"},{"type":"table","reportId":"v0000001-0001-4000-8000-000000000003"}]}', ARRAY['1b000001-0001-4000-8000-000000000001'::uuid, '1b000001-0001-4000-8000-000000000003'::uuid, '1b000001-0001-4000-8000-000000000004'::uuid, '1b000001-0001-4000-8000-000000000006'::uuid])
ON CONFLICT (id) DO NOTHING;

INSERT INTO erp.data_snapshots (id, report_id, data, generated_at) VALUES
  ('28000001-0001-4000-8000-000000000001', '26000001-0001-4000-8000-000000000001', '{"rows":[{"month":"2026-01","revenue":8200},{"month":"2026-02","revenue":18500}]}', '2026-02-28'),
  ('28000001-0001-4000-8000-000000000002', '26000001-0001-4000-8000-000000000002', '{"rows":[{"lifecycle_stage":"lead","count":15},{"lifecycle_stage":"customer","count":20},{"lifecycle_stage":"loyal","count":10},{"lifecycle_stage":"churned","count":5}]}', '2026-02-24'),
  ('28000001-0001-4000-8000-000000000003', '26000001-0001-4000-8000-000000000001', '{"rows":[{"month":"2026-01","revenue":8200}]}', '2026-02-01')
ON CONFLICT (id) DO NOTHING;
