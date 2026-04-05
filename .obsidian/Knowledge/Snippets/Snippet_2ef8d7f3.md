Task: Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.
Tags: #эратосфена #помощью #решета #напиши #hints

Here’s a clean implementation of the Sieve of Eratosthenes in Python, complete with a docstring and type hints:

```python
from typing import List

def sieve_of_eratosthenes(n: int) -> List[int]:
    """
    Return a list of all prime numbers less than or equal to ``n`` using
    the Sieve of Eratosthenes algorithm.

    Parameters
    ----------
    n : int
        The upper bound (inclusive) for the search. Must be a non‑negative integer.

    Returns
    -------
    List[int]
        A list containing all prime numbers ≤ ``n``. Returns an empty list
        for ``n < 2``.

    Examples
    --------
    >>> sieve_of_eratosthenes(10)
    [2, 3, 5, 7]
    >>> sieve_of_eratosthenes(1)
    []
    """
    if n < 2:
        return []

    # Initially assume every number from 0..n is prime (True), then eliminate.
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False  # 0 and 1 are not prime

    # Only need to cross out multiples up to sqrt(n)
    limit = int(n ** 0.5) + 1
    for p in range(2, limit):
        if is_prime[p]:
            # Mark all multiples of p (starting at p*p) as non‑prime
            for multiple in range(p * p, n + 1, p):
                is_prime[multiple] = False

    # Extract the indices that remain marked as prime
    return [i for i, prime in enumerate(is_prime) if prime]
```

**How it works**

1. Create a boolean list `is_prime` where each index represents whether that number is prime.
2. Iterate from `2` up to `√n`. For each prime `p` found, mark its multiples (`p*p, p*p+p, …`) as non‑prime.
3. After the loop, the indices still marked `True` are the prime numbers; collect them into a list and return.

The function runs in **O(n log log n)** time and uses **O(n)** auxiliary space, which is optimal for the sieve method. Feel free to copy and use it directly in your projects!
