import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Get Supabase environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// TEMPORARY FIX: Using service role to bypass RLS issues
// TODO: Investigate why anon role INSERT policy is not working despite being created
// The policy exists in Supabase Dashboard but anon client still gets RLS violation
function getSupabaseClient() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase environment variables');
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Validate required fields
    const { email, gift_type, completed_prompts, password, source } = body;

    if (!email || !gift_type) {
      return NextResponse.json(
        { error: 'Missing required fields: email and gift_type' },
        { status: 400 }
      );
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    const supabase = getSupabaseClient();

    // Check if email already exists for this gift type
    const { data: existingLead, error: checkError } = await supabase
      .from('gift_leads')
      .select('id, email')
      .eq('email', email)
      .eq('gift_type', gift_type)
      .single();

    if (existingLead) {
      // Email already registered for this gift type
      return NextResponse.json(
        {
          success: true,
          message: 'Email already registered',
          already_exists: true
        },
        { status: 200 }
      );
    }

    // Insert new lead
    const { data, error } = await supabase
      .from('gift_leads')
      .insert([
        {
          email: email.toLowerCase().trim(),
          gift_type,
          completed_prompts: completed_prompts || 0,
          password: password || null,
          source: source || 'unknown',
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Supabase insert error:', error);
      return NextResponse.json(
        { error: 'Failed to save email', details: error.message },
        { status: 500 }
      );
    }

    // Log success
    console.log('✅ Gift lead saved:', {
      email: email.toLowerCase().trim(),
      gift_type,
      password,
      source,
    });

    return NextResponse.json(
      {
        success: true,
        message: 'Email saved successfully',
        data: {
          id: data.id,
          email: data.email,
        }
      },
      { status: 201 }
    );

  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET endpoint to retrieve leads (requires authentication)
export async function GET(request: Request) {
  try {
    const supabase = getSupabaseClient();

    // This endpoint should be protected - only for admin use
    const { searchParams } = new URL(request.url);
    const password = searchParams.get('password');
    const limit = parseInt(searchParams.get('limit') || '100');

    let query = supabase
      .from('gift_leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (password) {
      query = query.eq('password', password);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Supabase query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch leads' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        count: data.length,
        data
      },
      { status: 200 }
    );

  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
