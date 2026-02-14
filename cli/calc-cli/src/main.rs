use std::env;
use std::fmt;
use std::io::{self, BufRead};

#[derive(Debug)]
enum Token {
    Num(f64),
    Plus,
    Minus,
    Mul,
    Div,
    Mod,
    Pow,
    LParen,
    RParen,
}

#[derive(Debug)]
enum CalcError {
    ParseError(String),
    DivisionByZero,
    UnexpectedToken(String),
    UnexpectedEnd,
}

impl fmt::Display for CalcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CalcError::ParseError(s) => write!(f, "parse error: {}", s),
            CalcError::DivisionByZero => write!(f, "division by zero"),
            CalcError::UnexpectedToken(s) => write!(f, "unexpected token: {}", s),
            CalcError::UnexpectedEnd => write!(f, "unexpected end of expression"),
        }
    }
}

fn tokenize(input: &str) -> Result<Vec<Token>, CalcError> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&ch) = chars.peek() {
        match ch {
            ' ' | '\t' => { chars.next(); }
            '0'..='9' | '.' => {
                let mut num_str = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_ascii_digit() || c == '.' {
                        num_str.push(c);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let n: f64 = num_str.parse()
                    .map_err(|_| CalcError::ParseError(format!("invalid number: {}", num_str)))?;
                tokens.push(Token::Num(n));
            }
            '+' => { tokens.push(Token::Plus); chars.next(); }
            '-' => {
                // Handle negative numbers: unary minus at start or after operator/lparen
                let is_unary = tokens.is_empty() || matches!(
                    tokens.last(),
                    Some(Token::Plus | Token::Minus | Token::Mul | Token::Div
                         | Token::Mod | Token::Pow | Token::LParen)
                );
                if is_unary {
                    chars.next();
                    let mut num_str = String::from("-");
                    while let Some(&c) = chars.peek() {
                        if c.is_ascii_digit() || c == '.' {
                            num_str.push(c);
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    if num_str == "-" {
                        tokens.push(Token::Minus);
                    } else {
                        let n: f64 = num_str.parse()
                            .map_err(|_| CalcError::ParseError(format!("invalid number: {}", num_str)))?;
                        tokens.push(Token::Num(n));
                    }
                } else {
                    tokens.push(Token::Minus);
                    chars.next();
                }
            }
            '*' => {
                chars.next();
                if chars.peek() == Some(&'*') {
                    chars.next();
                    tokens.push(Token::Pow);
                } else {
                    tokens.push(Token::Mul);
                }
            }
            '/' => { tokens.push(Token::Div); chars.next(); }
            '%' => { tokens.push(Token::Mod); chars.next(); }
            '^' => { tokens.push(Token::Pow); chars.next(); }
            '(' => { tokens.push(Token::LParen); chars.next(); }
            ')' => { tokens.push(Token::RParen); chars.next(); }
            _ => return Err(CalcError::UnexpectedToken(format!("'{}'", ch))),
        }
    }
    Ok(tokens)
}

// Recursive descent parser: expr -> term ((+|-) term)*
// term -> power ((*|/|%) power)*
// power -> atom (^ power)?
// atom -> number | '(' expr ')'

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<&Token> {
        let tok = self.tokens.get(self.pos);
        self.pos += 1;
        tok
    }

    fn parse(&mut self) -> Result<f64, CalcError> {
        let result = self.expr()?;
        if self.pos < self.tokens.len() {
            return Err(CalcError::UnexpectedToken(format!("{:?}", self.tokens[self.pos])));
        }
        Ok(result)
    }

    fn expr(&mut self) -> Result<f64, CalcError> {
        let mut left = self.term()?;
        loop {
            match self.peek() {
                Some(Token::Plus) => { self.next(); left += self.term()?; }
                Some(Token::Minus) => { self.next(); left -= self.term()?; }
                _ => break,
            }
        }
        Ok(left)
    }

    fn term(&mut self) -> Result<f64, CalcError> {
        let mut left = self.power()?;
        loop {
            match self.peek() {
                Some(Token::Mul) => { self.next(); left *= self.power()?; }
                Some(Token::Div) => {
                    self.next();
                    let right = self.power()?;
                    if right == 0.0 {
                        return Err(CalcError::DivisionByZero);
                    }
                    left /= right;
                }
                Some(Token::Mod) => {
                    self.next();
                    let right = self.power()?;
                    if right == 0.0 {
                        return Err(CalcError::DivisionByZero);
                    }
                    left %= right;
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn power(&mut self) -> Result<f64, CalcError> {
        let base = self.atom()?;
        if matches!(self.peek(), Some(Token::Pow)) {
            self.next();
            let exp = self.power()?; // right-associative
            Ok(base.powf(exp))
        } else {
            Ok(base)
        }
    }

    fn atom(&mut self) -> Result<f64, CalcError> {
        match self.next() {
            Some(Token::Num(n)) => Ok(*n),
            Some(Token::LParen) => {
                let val = self.expr()?;
                match self.next() {
                    Some(Token::RParen) => Ok(val),
                    _ => Err(CalcError::ParseError("missing closing ')'".into())),
                }
            }
            Some(tok) => Err(CalcError::UnexpectedToken(format!("{:?}", tok))),
            None => Err(CalcError::UnexpectedEnd),
        }
    }
}

fn evaluate(input: &str) -> Result<f64, CalcError> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(CalcError::UnexpectedEnd);
    }
    let mut parser = Parser::new(tokens);
    parser.parse()
}

fn format_result(val: f64) -> String {
    if val == val.floor() && val.abs() < 1e15 {
        format!("{}", val as i64)
    } else {
        format!("{}", val)
    }
}

fn print_json_result(expr: &str, val: f64) {
    println!(
        r#"{{"expression":"{}","result":{}}}"#,
        expr.replace('\\', "\\\\").replace('"', "\\\""),
        format_result(val)
    );
}

fn print_json_error(expr: &str, err: &CalcError) {
    println!(
        r#"{{"expression":"{}","error":"{}"}}"#,
        expr.replace('\\', "\\\\").replace('"', "\\\""),
        err
    );
}

fn print_help() {
    eprintln!("calc-cli - A simple calculator for OpenClaw CLI Backend");
    eprintln!();
    eprintln!("Usage:");
    eprintln!("  calc-cli <expression>          Evaluate a single expression");
    eprintln!("  calc-cli --expr '<expression>'  Same, explicit flag");
    eprintln!("  echo '<expression>' | calc-cli --stdin   Read from stdin");
    eprintln!("  calc-cli --interactive          Interactive REPL mode");
    eprintln!();
    eprintln!("Output: JSON  {{\"expression\": \"...\", \"result\": ...}}");
    eprintln!();
    eprintln!("Supported operators: + - * / % ^ ** ()");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  calc-cli '2 + 3 * 4'           => {{\"expression\":\"2 + 3 * 4\",\"result\":14}}");
    eprintln!("  calc-cli '(1 + 2) ^ 3'         => {{\"expression\":\"(1 + 2) ^ 3\",\"result\":27}}");
    eprintln!("  calc-cli --expr '100 / 3'       => {{\"expression\":\"100 / 3\",\"result\":33.333...}}");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        print_help();
        std::process::exit(1);
    }

    match args[0].as_str() {
        "--help" | "-h" => {
            print_help();
        }
        "--stdin" => {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                let line = line.unwrap_or_default();
                let line = line.trim();
                if line.is_empty() { continue; }
                match evaluate(line) {
                    Ok(val) => print_json_result(line, val),
                    Err(e) => print_json_error(line, &e),
                }
            }
        }
        "--interactive" => {
            eprintln!("calc-cli interactive mode (type 'quit' to exit)");
            let stdin = io::stdin();
            loop {
                eprint!("> ");
                let mut line = String::new();
                if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 { break; }
                let line = line.trim();
                if line.is_empty() { continue; }
                if line == "quit" || line == "exit" { break; }
                match evaluate(line) {
                    Ok(val) => println!("{}", format_result(val)),
                    Err(e) => eprintln!("Error: {}", e),
                }
            }
        }
        "--expr" => {
            if args.len() < 2 {
                eprintln!("Error: --expr requires an expression argument");
                std::process::exit(1);
            }
            let expr = args[1..].join(" ");
            match evaluate(&expr) {
                Ok(val) => print_json_result(&expr, val),
                Err(e) => { print_json_error(&expr, &e); std::process::exit(1); }
            }
        }
        _ => {
            let expr = args.join(" ");
            match evaluate(&expr) {
                Ok(val) => print_json_result(&expr, val),
                Err(e) => { print_json_error(&expr, &e); std::process::exit(1); }
            }
        }
    }
}
