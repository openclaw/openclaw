// Ternary gene encoding — SHA-256 → balanced ternary {-, 0, +}
// Deterministic routing: same description always produces same gene.
// No embeddings. No APIs. No cloud. Pure math.

use sha2::{Sha256, Digest};

/// A 48-trit balanced ternary gene. Each trit is -1, 0, or +1.
#[derive(Debug, Clone)]
pub struct Gene {
    pub trits: Vec<i8>,
}

impl Gene {
    /// Create gene from text via SHA-256 → balanced ternary conversion.
    pub fn from_text(text: &str) -> Self {
        let hash = Sha256::digest(text.as_bytes());
        let mut trits = Vec::with_capacity(48);

        for &byte in hash.iter() {
            let mut b = byte;
            for _ in 0..5 {
                let val = (b % 3) as i8;
                let trit = match val {
                    0 => 0,
                    1 => 1,
                    2 => -1,
                    _ => unreachable!(),
                };
                trits.push(trit);
                b /= 3;
                if trits.len() >= 48 { break; }
            }
            if trits.len() >= 48 { break; }
        }

        Gene { trits }
    }

    /// Cosine similarity in trit space.
    pub fn similarity(&self, other: &Gene) -> f64 {
        let n = self.trits.len().min(other.trits.len());
        if n == 0 { return 0.0; }

        let dot: f64 = (0..n)
            .map(|i| (self.trits[i] as f64) * (other.trits[i] as f64))
            .sum();
        let mag_a: f64 = self.trits[..n].iter().map(|&t| (t as f64).powi(2)).sum::<f64>().sqrt();
        let mag_b: f64 = other.trits[..n].iter().map(|&t| (t as f64).powi(2)).sum::<f64>().sqrt();

        if mag_a == 0.0 || mag_b == 0.0 { return 0.0; }
        dot / (mag_a * mag_b)
    }

    /// Display as ternary string: +, 0, -
    pub fn to_string(&self) -> String {
        self.trits.iter().map(|&t| match t {
            -1 => '-',
            0 => '0',
            1 => '+',
            _ => '?',
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gene_deterministic() {
        let a = Gene::from_text("test");
        let b = Gene::from_text("test");
        assert_eq!(a.trits, b.trits);
    }

    #[test]
    fn gene_length() {
        let g = Gene::from_text("hello world");
        assert_eq!(g.trits.len(), 48);
    }

    #[test]
    fn gene_self_similarity() {
        let g = Gene::from_text("test");
        let sim = g.similarity(&g);
        assert!((sim - 1.0).abs() < 0.001);
    }

    #[test]
    fn gene_different_texts() {
        let a = Gene::from_text("explore search find locate");
        let b = Gene::from_text("write create build implement");
        let sim = a.similarity(&b);
        assert!(sim < 0.9); // Different tasks should have different genes
    }

    #[test]
    fn gene_display() {
        let g = Gene::from_text("test");
        let s = g.to_string();
        assert_eq!(s.len(), 48);
        assert!(s.chars().all(|c| c == '+' || c == '0' || c == '-'));
    }
}
